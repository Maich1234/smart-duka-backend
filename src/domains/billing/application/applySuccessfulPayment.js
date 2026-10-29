import mongoose from 'mongoose';
import Shop from '../../../models/Shop.js';
import SubscriptionPayment from '../../../models/SubscriptionPayment.js';
import { getBillableUserCount } from '../../../services/subscriptionPricingService.js';
import Subscription from '../../../models/Subscription.js';
import Promotion from '../../../models/Promotion.js';
import { activateSeatPayment } from '../../../services/seatActivationService.js';
import { rewardReferrerIfFirstConversion } from './rewardReferrerIfFirstConversion.js';

function addCycle(date, cycle) {
  const d = new Date(date);
  const day = d.getUTCDate();
  const months = cycle === 'yearly' ? 12 : cycle === 'quarterly' ? 3 : 1;
  // UTC keeps billing independent of the server's time zone. Clamp dates
  // such as January 31 to February's last day instead of skipping into March.
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/**
 * Atomically claims one redemption slot on a promotion — increments
 * redemptionCount only if the promotion is, at this exact moment, still
 * active, within its start/end window, and under its redemption cap.
 * Re-checks the same conditions as Promotion.isRedeemable(), but as a single
 * conditional update instead of check-then-write, so two payments racing to
 * redeem the last slot of a capped promo can never both succeed. Returns the
 * updated document, or null if the claim lost.
 */
async function claimPromotionRedemption(promotionId, session) {
  const now = new Date();
  return Promotion.findOneAndUpdate(
    {
      _id: promotionId,
      active: true,
      $and: [
        { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
        { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] },
      ],
      $expr: { $or: [{ $eq: ['$maxRedemptions', null] }, { $lt: ['$redemptionCount', '$maxRedemptions'] }] },
    },
    { $inc: { redemptionCount: 1 } },
    { new: true, session }
  );
}

/** Commits the service period, promotion redemption and payment marker together.
 * Fresh reads inside the transaction make callback/reconciliation retries safe.
 * The shop write also serializes activation with staff billing changes. */
export async function applySuccessfulPayment(payment) {
  if (payment.purpose === 'seat_addition') return activateSeatPayment(payment);
  const session = await mongoose.startSession();
  let committed;
  try {
    await session.withTransaction(async () => {
      committed = null;
      const lock = await Shop.updateOne({ _id: payment.shop }, { $inc: { staffBillingRevision: 1 } }, { session });
      if (!lock.matchedCount) throw new Error('Payment shop is no longer available.');
      const current = await SubscriptionPayment.findById(payment._id).session(session);
      if (!current) throw new Error('Payment is no longer available.');
      if (current.periodEnd) {
        committed = { periodStart: current.periodStart, periodEnd: current.periodEnd, applied: false };
        return;
      }
      if (current.status !== 'success') throw new Error('Only a confirmed successful payment can activate a subscription.');
      if (current.provider === 'bank' && !current.providerConfirmedAt) {
        throw new Error('Bank payment requires a verified amount and currency before activation.');
      }
      const subscription = await Subscription.findOne({ _id: current.subscription, shop: current.shop }).session(session);
      if (!subscription) throw new Error('Payment subscription is no longer available.');

      if (current.promotion) {
        const claimed = await claimPromotionRedemption(current.promotion, session);
        if (!claimed && current.provider === 'free') {
          throw Object.assign(new Error('This promo code is no longer available.'), { code: 'PROMOTION_UNAVAILABLE' });
        }
        // A completed real charge must still receive service if its promotion
        // expired while the provider was processing it.
      }
      const now = new Date();
      const candidates = [now, subscription.trialEnd, subscription.currentPeriodEnd].filter(Boolean);
      const periodStart = new Date(Math.max(...candidates.map(d => new Date(d).getTime())));
      const periodEnd = addCycle(periodStart, current.billingCycle);
      subscription.status = 'active';
      subscription.plan = current.plan;
      subscription.billingCycle = current.billingCycle;
      subscription.currentPeriodEnd = periodEnd;
      subscription.staffCount = await getBillableUserCount(current.shop, session);
      subscription.amountPaid = current.amount;
      subscription.currency = current.currency;
      subscription.paymentProvider = current.provider;
      subscription.paymentReference = current.receipt ?? current.providerRef;
      subscription.promotion = current.promotion ?? subscription.promotion;
      subscription.cancelledAt = null;
      // Clear only the lines priced into this invoice. Staff changes made
      // during the provider's delay remain due on the next invoice.
      if (current.seatAdjustmentIds != null) {
        const settled = new Set(current.seatAdjustmentIds.map(String));
        subscription.seatAdjustments = subscription.seatAdjustments.filter(a => !settled.has(String(a._id)));
      } else {
        // Existing pending payments predate explicit invoice snapshots.
        subscription.seatAdjustments = subscription.seatAdjustments.filter(a => a.createdAt > current.createdAt);
      }
      if (current.referralDiscount > 0) subscription.referralDiscountPercent = 0;
      await subscription.save({ session });
      current.periodStart = periodStart;
      current.periodEnd = periodEnd;
      await current.save({ session });
      committed = { periodStart, periodEnd, applied: true };
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
  } finally { await session.endSession(); }
  // Keep caller responses accurate without retaining a completed session.
  payment.periodStart = committed.periodStart;
  payment.periodEnd = committed.periodEnd;
  if (committed.applied) await rewardReferrerIfFirstConversion(payment.shop);
}

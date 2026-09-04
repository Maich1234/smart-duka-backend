import Subscription from '../../../models/Subscription.js';
import Promotion from '../../../models/Promotion.js';
import { clearSeatAdjustments } from '../../../services/seatBillingService.js';
import { activateSeatPayment } from '../../../services/seatActivationService.js';
import { rewardReferrerIfFirstConversion } from './rewardReferrerIfFirstConversion.js';

function addCycle(date, cycle) {
  const d = new Date(date);
  if (cycle === 'yearly') d.setFullYear(d.getFullYear() + 1);
  else if (cycle === 'quarterly') d.setMonth(d.getMonth() + 3);
  else d.setMonth(d.getMonth() + 1);
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
async function claimPromotionRedemption(promotionId) {
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
    { new: true }
  );
}

/**
 * Extends the subscription for a payment that just succeeded. Idempotent —
 * safe to call more than once for the same payment (the reconciliation path
 * may re-run this for a payment whose activation is uncertain) — a payment
 * only ever gets `periodEnd` set once real processing has happened, so a
 * second call is a no-op rather than double-crediting a promo redemption.
 */
export async function applySuccessfulPayment(payment) {
  if (payment.purpose === 'seat_addition') return activateSeatPayment(payment);
  if (payment.periodEnd) return;

  const subscription = await Subscription.findById(payment.subscription);
  if (!subscription) {
    console.error('[Subscriptions Callback] Payment has no subscription:', payment._id);
    return;
  }

  // Claimed up front, before any subscription/payment mutation: a promo can
  // expire or hit its cap between initiation and here (M-Pesa/Paystack are
  // async), and this is the one place that actually spends a redemption.
  if (payment.promotion) {
    const claimed = await claimPromotionRedemption(payment.promotion);
    if (!claimed) {
      // A 'free' activation charged nothing and is being granted in the same
      // request that validated the promo — safe, and correct, to hard-fail
      // rather than hand out a redemption that just lost the eligibility
      // race. A real charge (mpesa/card/bank) already took the customer's
      // money by the time this runs, so it must still activate — the
      // discrepancy is logged, not used to strand a paying customer.
      if (payment.provider === 'free') {
        const err = new Error('This promo code is no longer available.');
        err.code = 'PROMOTION_UNAVAILABLE';
        throw err;
      }
      console.warn(`[Subscriptions] Promotion ${payment.promotion} exhausted or expired by completion time for payment ${payment._id} (${payment.provider}) — activating without a redemption credit.`);
    }
  }

  const now = new Date();
  const candidates = [now];
  if (subscription.trialEnd && subscription.trialEnd > now) candidates.push(new Date(subscription.trialEnd));
  if (subscription.currentPeriodEnd && subscription.currentPeriodEnd > now) candidates.push(new Date(subscription.currentPeriodEnd));
  const periodStart = new Date(Math.max(...candidates.map((d) => d.getTime())));
  const periodEnd = addCycle(periodStart, payment.billingCycle);

  subscription.status = 'active';
  subscription.plan = payment.plan;
  subscription.billingCycle = payment.billingCycle;
  subscription.currentPeriodEnd = periodEnd;
  subscription.staffCount = payment.staffCount;
  subscription.amountPaid = payment.amount;
  subscription.currency = payment.currency;
  subscription.paymentProvider = payment.provider;
  subscription.paymentReference = payment.receipt ?? payment.providerRef;
  subscription.promotion = payment.promotion ?? subscription.promotion;
  subscription.cancelledAt = null;
  // Accrued mid-period seat changes were folded into this payment's amount —
  // settle them so they can't be billed twice on the following invoice.
  clearSeatAdjustments(subscription);
  // This shop's own banked referral credit was spent on this payment (see
  // computePrice's referralCreditPercent) — consumed in full, never
  // fractioned across future payments, mirroring how promotion redemption is
  // only counted on confirmed success below, never at initiation.
  if (payment.referralDiscount > 0) {
    subscription.referralDiscountPercent = 0;
  }
  await subscription.save();

  payment.periodStart = periodStart;
  payment.periodEnd = periodEnd;
  await payment.save();

  await rewardReferrerIfFirstConversion(payment.shop);
}

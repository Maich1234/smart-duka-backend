import mongoose from 'mongoose';
import Shop from '../../../models/Shop.js';
import SubscriptionPayment from '../../../models/SubscriptionPayment.js';

const CHECKOUT_WAIT_MS = 3 * 60 * 1000;
export const subscriptionCheckoutCutoff = () => new Date(Date.now() - CHECKOUT_WAIT_MS);

export function isCheckoutReleased(payment) {
  return payment.purpose !== 'seat_addition' &&
    ['pending', 'timeout'].includes(payment.status) &&
    payment.createdAt != null && payment.createdAt <= subscriptionCheckoutCutoff();
}

export function findUnfinishedCheckout(shopId, session = null) {
  return SubscriptionPayment.findOne({
    shop: shopId,
    purpose: { $ne: 'seat_addition' },
    $or: [
      { status: { $in: ['pending', 'timeout'] }, createdAt: { $gt: subscriptionCheckoutCutoff() } },
      { status: 'success', periodEnd: null, duplicateOf: null },
    ],
  }).sort({ createdAt: -1 }).session(session);
}

/** Serialize reservation per shop, including different keys/providers.
 * Provider calls must stay outside this retryable transaction. */
export async function reserveSubscriptionCheckout(data) {
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const lock = await Shop.updateOne({ _id: data.shop }, { $inc: { staffBillingRevision: 1 } }, { session });
      if (!lock.matchedCount) throw new Error('Payment shop is no longer available.');
      const existing = await SubscriptionPayment.findOne({ shop: data.shop, idempotencyKey: data.idempotencyKey }).session(session)
        ?? await findUnfinishedCheckout(data.shop, session);
      if (existing) {
        result = { payment: existing, created: false };
        return;
      }
      // Existing attempts predate period grouping. Join released legacy
      // attempts to the same billing period before dispatching a replacement.
      await SubscriptionPayment.updateMany({
        shop: data.shop,
        subscription: data.subscription,
        purpose: { $ne: 'seat_addition' },
        checkoutPeriodKey: null,
        status: { $in: ['pending', 'timeout'] },
        createdAt: { $lte: subscriptionCheckoutCutoff() },
      }, { $set: { checkoutPeriodKey: data.checkoutPeriodKey } }, { session });
      const winner = await SubscriptionPayment.findOne({
        subscription: data.subscription,
        checkoutPeriodKey: data.checkoutPeriodKey,
        periodEnd: { $ne: null },
      }).session(session);
      if (winner) {
        result = { payment: winner, created: false };
        return;
      }
      const [payment] = await SubscriptionPayment.create([data], { session });
      result = { payment, created: true };
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    result.payment.$session(null);
    return result;
  } finally { await session.endSession(); }
}

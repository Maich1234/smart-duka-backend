import SubscriptionPayment from '../../../models/SubscriptionPayment.js';

/** A delayed failure or stale status query must never undo confirmed success.
 * Return the fresh record even if another handler won, so callers can repair
 * a confirmed payment whose activation previously failed. */
export async function recordPaymentOutcome(paymentId, outcome) {
  const eligible = outcome.status === 'success'
    ? [{ status: { $ne: 'success' } }, { status: 'success', providerConfirmedAt: null }]
    : [{ status: { $in: ['pending', 'timeout'] } }, { provider: 'bank', status: 'success', providerConfirmedAt: null }];
  const filter = { _id: paymentId, periodEnd: null, $or: eligible };
  const fields = outcome.status === 'success' ? { ...outcome, providerConfirmedAt: new Date() } : outcome;
  const updated = await SubscriptionPayment.findOneAndUpdate(filter, { $set: fields }, { new: true });
  return { payment: updated ?? await SubscriptionPayment.findById(paymentId), changed: !!updated };
}

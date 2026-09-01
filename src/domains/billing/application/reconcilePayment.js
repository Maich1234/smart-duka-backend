import { getPaymentProvider } from '../infra/payments/index.js';
import { paystackAmountMismatch } from '../domain/fraud.js';
import { applySuccessfulPayment } from './applySuccessfulPayment.js';
import { cleanupFailedSeatPayment } from './seatCleanup.js';

// M-Pesa result codes, plus Paystack's own textual transaction statuses —
// distinct alphabets, no collision risk sharing one set.
const DEFINITIVE_FAILURE_CODES = new Set(['1032', '1037', '1001', '1', '2001', '1025', 'failed', 'abandoned', 'reversed']);
const CANCELLED_CODES = new Set(['1032', 'abandoned']);

/**
 * Re-verifies a payment directly against Safaricom's STK Push Query — the
 * safety net for whenever the async callback never arrives at all, or
 * arrived but activation didn't complete (the bug this whole reconciliation
 * path exists to recover from). Safe to call on any payment that hasn't
 * been fully activated yet, regardless of its current status: `pending`,
 * `timeout`, or a `success` whose activation silently failed.
 *
 * `receiptHint` (e.g. from a user-pasted M-Pesa SMS) is stored as the
 * receipt when Safaricom's status query itself can't supply one — unlike
 * the callback, the query response never includes the receipt number.
 */
export async function reconcilePayment(payment, { receiptHint } = {}) {
  // Subscription payments mark completion via periodEnd; seat-addition
  // payments never set it (there's no period to extend), so they're
  // considered resolved once their status says success.
  const alreadyResolved = payment.purpose === 'seat_addition' ? payment.status === 'success' : !!payment.periodEnd;
  if (alreadyResolved) {
    return { payment, changed: false };
  }

  const provider = getPaymentProvider(payment.provider);
  if (!provider.queryStatus) {
    return { payment, changed: false };
  }

  let result;
  try {
    result = await provider.queryStatus({ checkoutRequestId: payment.providerRef });
  } catch (err) {
    console.error('[Subscriptions] reconcilePayment query failed:', err.message);
    return { payment, changed: false };
  }

  if (result.success) {
    const mismatch = paystackAmountMismatch(payment, result.amountKobo);
    if (mismatch) {
      payment.status = 'failed';
      payment.resultCode = result.resultCode;
      payment.errorMessage = mismatch;
      await payment.save();
      console.error('[Subscriptions] reconcilePayment', mismatch, 'payment', String(payment._id));
      return { payment, changed: true };
    }

    payment.status = 'success';
    payment.resultCode = result.resultCode;
    payment.errorMessage = null;
    payment.receipt = payment.receipt ?? receiptHint ?? null;
    payment.transactionDate = payment.transactionDate ?? new Date();
    await payment.save();
    await applySuccessfulPayment(payment);
    return { payment, changed: true };
  }

  if (result.resultCode && DEFINITIVE_FAILURE_CODES.has(result.resultCode)) {
    const status = CANCELLED_CODES.has(result.resultCode) ? 'cancelled' : 'failed';
    payment.status = status;
    payment.resultCode = result.resultCode;
    payment.errorMessage = result.resultDesc ?? 'Payment did not complete.';
    await payment.save();
    await cleanupFailedSeatPayment(payment);
    return { payment, changed: true };
  }

  // Inconclusive (still processing on Safaricom's side, or the query itself
  // errored) — leave the payment exactly as it was; a later reconcile
  // attempt (cron or another manual recheck) will re-verify.
  return { payment, changed: false };
}

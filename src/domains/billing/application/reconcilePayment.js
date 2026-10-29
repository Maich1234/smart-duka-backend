import { getPaymentProvider } from '../infra/payments/index.js';
import { paystackAmountMismatch } from '../domain/fraud.js';
import { applySuccessfulPayment } from './applySuccessfulPayment.js';
import { cleanupFailedSeatPayment } from './seatCleanup.js';
import { recordPaymentOutcome } from './recordPaymentOutcome.js';

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

  // A previous authenticated callback already confirmed the money. Repair
  // activation directly; provider downtime must not strand that confirmation.
  if (payment.status === 'success' && (payment.provider !== 'bank' || payment.providerConfirmedAt)) {
    await applySuccessfulPayment(payment);
    return { payment, changed: true };
  }
  if (!payment.providerRef) return { payment, changed: false };

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

  if (result.success || (result.resultCode && DEFINITIVE_FAILURE_CODES.has(result.resultCode))) {
    const mismatch = result.success ? paystackAmountMismatch(payment, result.amountKobo, result.currency) : null;
    const status = result.success && !mismatch ? 'success'
      : CANCELLED_CODES.has(result.resultCode) ? 'cancelled' : 'failed';
    const outcome = {
      status,
      resultCode: result.resultCode,
      errorMessage: mismatch ?? (result.success ? null : result.resultDesc ?? 'Payment did not complete.'),
      ...(status === 'success' && {
        receipt: payment.receipt ?? receiptHint ?? null,
        transactionDate: payment.transactionDate ?? new Date(),
      }),
    };
    const recorded = await recordPaymentOutcome(payment._id, outcome);
    if (!recorded.payment) return { payment, changed: false };
    const needsActivation = recorded.payment.status === 'success' && !recorded.payment.periodEnd;
    if (recorded.payment.status === 'success') {
      if (needsActivation) await applySuccessfulPayment(recorded.payment);
    } else if (recorded.changed) {
      await cleanupFailedSeatPayment(recorded.payment);
    }
    payment.set(recorded.payment.toObject());
    return { payment, changed: recorded.changed || needsActivation };
  }

  // Inconclusive (still processing on Safaricom's side, or the query itself
  // errored) — leave the payment exactly as it was; a later reconcile
  // attempt (cron or another manual recheck) will re-verify.
  return { payment, changed: false };
}

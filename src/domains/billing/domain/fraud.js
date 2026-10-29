/**
 * Paystack's popup runs client-side against the public key (unlike M-Pesa's
 * STK push, which the server initiates with the amount already locked in),
 * so the amount that reaches Paystack passed through the browser. Shared by
 * the webhook and the on-demand reconcile path — both must refuse to credit
 * a mismatch rather than trust whatever the browser told Paystack to charge.
 */
export function paystackAmountMismatch(payment, amountKobo, currency) {
  if (payment.provider !== 'bank') return null;
  if (!Number.isSafeInteger(amountKobo) || amountKobo < 0) {
    return 'Provider confirmation is missing a valid payment amount.';
  }
  if (typeof currency !== 'string' || currency.toUpperCase() !== payment.currency.toUpperCase()) {
    return 'Provider confirmation currency does not match the invoice.';
  }
  const expectedKobo = Math.round(payment.amount * 100);
  return amountKobo === expectedKobo ? null : `Amount mismatch: provider confirmed ${amountKobo}, expected ${expectedKobo}.`;
}

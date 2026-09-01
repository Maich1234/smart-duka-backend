/**
 * Paystack's popup runs client-side against the public key (unlike M-Pesa's
 * STK push, which the server initiates with the amount already locked in),
 * so the amount that reaches Paystack passed through the browser. Shared by
 * the webhook and the on-demand reconcile path — both must refuse to credit
 * a mismatch rather than trust whatever the browser told Paystack to charge.
 */
export function paystackAmountMismatch(payment, amountKobo) {
  if (amountKobo == null) return null;
  const expectedKobo = Math.round(payment.amount * 100);
  return amountKobo === expectedKobo ? null : `Amount mismatch: provider confirmed ${amountKobo}, expected ${expectedKobo}.`;
}

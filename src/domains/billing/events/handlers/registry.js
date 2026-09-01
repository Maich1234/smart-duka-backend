// Maps a BillingEvent.type to the ordered list of handler modules that must
// run for it. Each handler is { key, run(event) }. Empty for every type for
// now — later phases register real handlers here (email, push, sms,
// promotionReferral, seatActivation, seatInviteEmail, disputeFlag). An event
// with zero registered handlers for its type completes immediately (see
// events/dispatch.js), which is exactly what lets this plumbing land inert:
// nothing calls emitBillingEvent yet, and even a hand-created test event
// completes with nothing to run.
export const HANDLERS_BY_TYPE = {
  'subscription.payment_succeeded': [],
  'seat_addition.payment_succeeded': [],
  'subscription.payment_disputed': [],
};

export function handlersFor(type) {
  return HANDLERS_BY_TYPE[type] ?? [];
}

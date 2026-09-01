import BillingEvent from './BillingEvent.js';
import { handlersFor } from './handlers/registry.js';
import { publishToQStash } from './publish.js';

/**
 * Records a domain event in the outbox — idempotent per (payment, type), so
 * a retried applySuccessfulPayment call (or a rare reconcile/webhook race)
 * emits at most one event for the same payment — then makes a best-effort
 * attempt to publish it to QStash immediately. Never throws: a QStash hiccup
 * here must not block or fail the webhook/reconcile call that triggered it.
 * Anything that doesn't get published here is retried by the cron backstop
 * (cronController.billingEventsSweep).
 */
export async function emitBillingEvent({ type, paymentId, shopId, payload }) {
  const handlers = handlersFor(type).map((h) => ({ key: h.key, status: 'pending' }));

  let event;
  try {
    event = await BillingEvent.create({ type, shop: shopId, payment: paymentId, payload, handlers });
  } catch (err) {
    if (err.code === 11000) {
      // Already emitted for this (payment, type) — idempotent no-op.
      return BillingEvent.findOne({ payment: paymentId, type });
    }
    throw err;
  }

  await publishToQStash(event);
  return event;
}

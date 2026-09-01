import { getQStashClient, isQStashConfigured } from '../infra/qstash.js';

const PUBLISH_TIMEOUT_MS = 5000;

/**
 * Best-effort: publishes the event id (never the payload — the BillingEvent
 * row is the source of truth) to the billing-events dispatch endpoint via
 * QStash. Never throws — called inline right after a webhook/reconcile call
 * persists state, so a QStash hiccup here must never fail or delay that
 * response. Anything that doesn't get published here is retried by the cron
 * backstop (cronController.billingEventsSweep).
 */
export async function publishToQStash(event) {
  if (!isQStashConfigured()) {
    console.error('[BillingEvents] QStash is not configured — event', String(event._id), 'will wait for the cron backstop.');
    return;
  }
  const callbackUrl = process.env.BILLING_EVENTS_CALLBACK_URL;
  if (!callbackUrl) {
    console.error('[BillingEvents] BILLING_EVENTS_CALLBACK_URL is not configured — event', String(event._id), 'will wait for the cron backstop.');
    return;
  }

  event.publishAttempts += 1;
  try {
    const client = getQStashClient();
    const result = await Promise.race([
      client.publishJSON({ url: callbackUrl, body: { eventId: String(event._id) }, retries: 3 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('QStash publish timed out')), PUBLISH_TIMEOUT_MS)),
    ]);
    event.publishedAt = new Date();
    event.qstashMessageId = result?.messageId ?? null;
    event.lastPublishError = null;
  } catch (err) {
    event.lastPublishError = err.message;
    console.error('[BillingEvents] publish failed for event', String(event._id), '-', err.message);
  }
  await event.save().catch(() => {});
}

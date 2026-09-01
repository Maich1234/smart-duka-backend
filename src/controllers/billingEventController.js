import { getQStashReceiver, isQStashConfigured } from '../domains/billing/infra/qstash.js';
import { dispatchBillingEvent } from '../domains/billing/events/dispatch.js';

/**
 * POST /billing-events/dispatch — QStash calls this back for every event
 * emitBillingEvent publishes. Public (no JWT), same class as the M-Pesa and
 * Paystack webhooks — secured entirely by verifying QStash's own signature,
 * since nothing else here identifies the caller. Returns 200 only once every
 * handler for the event has actually finished; QStash retries on anything
 * else, which is most of this endpoint's retry logic for free.
 */
export const handleBillingEventDispatch = async (req, res) => {
  if (!isQStashConfigured()) {
    console.error('[BillingEvents] Received a dispatch call but QStash is not configured.');
    return res.status(503).json({ received: false });
  }

  let valid = false;
  try {
    valid = await getQStashReceiver().verify({
      signature: req.headers['upstash-signature'],
      body: req.rawBody?.toString('utf8') ?? '',
      url: process.env.BILLING_EVENTS_CALLBACK_URL,
    });
  } catch (err) {
    console.error('[BillingEvents] Signature verification failed:', err.message);
  }
  if (!valid) {
    return res.status(401).json({ received: false });
  }

  const eventId = req.body?.eventId;
  if (!eventId || typeof eventId !== 'string') {
    // Malformed payload we manufactured ourselves — nothing to retry into
    // existing, so still 2xx rather than making QStash spin forever on a
    // message that can never succeed.
    console.error('[BillingEvents] Dispatch call missing eventId');
    return res.status(200).json({ received: true });
  }

  try {
    const { status } = await dispatchBillingEvent(eventId);
    return res.status(status === 'completed' ? 200 : 500).json({ received: true, status });
  } catch (err) {
    console.error('[BillingEvents] dispatch error for event', eventId, '-', err.message);
    return res.status(500).json({ received: false });
  }
};

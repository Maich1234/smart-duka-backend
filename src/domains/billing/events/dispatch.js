import BillingEvent from './BillingEvent.js';
import { handlersFor } from './handlers/registry.js';
import { logAudit } from '../../../services/auditLogService.js';

const STALE_CLAIM_MS = 2 * 60 * 1000; // same stale-reclaim shape as middlewares/idempotency.js
const MAX_DISPATCH_ATTEMPTS = 10;

/**
 * Claims and runs every not-yet-finished handler for one outbox row.
 * Idempotent and safe to call concurrently (from the QStash-triggered route
 * and the cron backstop): only one caller can move a row out of
 * pending/stale-processing at a time. Each handler runs independently via
 * Promise.allSettled, so one failing side effect never blocks or loses the
 * others — a retry only re-runs what didn't finish.
 */
export async function dispatchBillingEvent(eventId) {
  const staleThreshold = new Date(Date.now() - STALE_CLAIM_MS);
  const event = await BillingEvent.findOneAndUpdate(
    {
      _id: eventId,
      status: { $in: ['pending', 'processing'] },
      $or: [{ claimedAt: null }, { claimedAt: { $lt: staleThreshold } }],
    },
    { $set: { status: 'processing', claimedAt: new Date() }, $inc: { dispatchAttempts: 1 } },
    { new: true },
  );
  if (!event) {
    // Either already completed/dead-lettered, or another delivery currently
    // owns a fresh (non-stale) claim — both are a no-op here, not an error.
    const existing = await BillingEvent.findById(eventId);
    return { status: existing?.status ?? 'unknown' };
  }

  const handlers = handlersFor(event.type);
  const pending = event.handlers.filter((h) => h.status !== 'done' && h.status !== 'skipped');

  await Promise.allSettled(pending.map(async (record) => {
    const handler = handlers.find((h) => h.key === record.key);
    record.attempts += 1;
    if (!handler) {
      // A handler that used to be registered for this type was removed —
      // nothing left to run for it.
      record.status = 'skipped';
      record.completedAt = new Date();
      return;
    }
    try {
      await handler.run(event);
      record.status = 'done';
      record.completedAt = new Date();
      record.lastError = null;
    } catch (err) {
      record.status = 'failed';
      record.lastError = err.message;
    }
  }));

  const allSettled = event.handlers.every((h) => h.status === 'done' || h.status === 'skipped');
  if (allSettled) {
    event.status = 'completed';
  } else if (event.dispatchAttempts >= MAX_DISPATCH_ATTEMPTS) {
    event.status = 'dead_letter';
    logAudit({
      shopId: event.shop,
      action: 'subscription.payment.event_dead_letter',
      entityType: 'BillingEvent',
      entityId: event._id,
      details: { type: event.type, handlers: event.handlers.map((h) => ({ key: h.key, status: h.status, lastError: h.lastError })) },
    }).catch(() => {});
  } else {
    event.status = 'pending';
  }
  event.claimedAt = null;
  await event.save();

  return { status: event.status };
}

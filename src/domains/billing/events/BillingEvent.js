import mongoose from 'mongoose';

// The outbox: one row per domain event a payment success needs to react to
// (receipt, email, push+in-app notification, SMS, promo/referral crediting,
// seat activation, dispute flagging...). Each handler is tracked
// independently so one failing side effect (a slow mail host, say) never
// blocks or loses the others, and so a retry only re-runs what didn't finish.
const billingEventSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['subscription.payment_succeeded', 'seat_addition.payment_succeeded', 'subscription.payment_disputed'],
    required: true,
    index: true,
  },
  shop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true, index: true },
  payment: { type: mongoose.Schema.Types.ObjectId, ref: 'SubscriptionPayment', required: true, index: true },
  // Denormalized snapshot at emission time — handlers never re-derive from
  // live DB state days later, so a subsequent unrelated edit to the
  // payment/subscription/plan can't change what a retried handler sends.
  payload: { type: mongoose.Schema.Types.Mixed, required: true },

  // Per-event dispatch status. 'pending' until every handler is done/skipped.
  status: { type: String, enum: ['pending', 'processing', 'completed', 'dead_letter'], default: 'pending', index: true },
  // Reclaim lock — same stale-claim shape as middlewares/idempotency.js.
  claimedAt: { type: Date, default: null },
  dispatchAttempts: { type: Number, default: 0 },

  // Publish-to-QStash bookkeeping.
  publishedAt: { type: Date, default: null },
  publishAttempts: { type: Number, default: 0 },
  lastPublishError: { type: String, default: null },
  qstashMessageId: { type: String, default: null },

  // One entry per handler registered for this event's type at creation time
  // (see events/handlers/registry.js) — not computed lazily, so
  // dispatchBillingEvent never has to guess which handlers apply.
  handlers: [{
    key: { type: String, required: true },
    status: { type: String, enum: ['pending', 'done', 'failed', 'skipped'], default: 'pending' },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: null },
    completedAt: { type: Date, default: null },
  }],
}, { timestamps: true });

// Idempotent emission: one event per (payment, type) — a retried
// applySuccessfulPayment call, or a rare reconcile/webhook race, creates at
// most one outbox row per payment.
billingEventSchema.index({ payment: 1, type: 1 }, { unique: true });

export default mongoose.model('BillingEvent', billingEventSchema);

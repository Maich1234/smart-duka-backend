import mongoose from 'mongoose';

// One subscription per shop. Stored status is the last explicit transition
// (trialing → active on payment, cancelled on request); time-derived states
// (trial expired, grace window, locked) are computed on read by
// deriveAccess() in subscriptionPricingService so a shop that goes unpaid
// never needs a background job to flip its status.
const subscriptionSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true,
    unique: true,
    index: true,
  },
  plan: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SubscriptionPlan',
    required: true,
  },
  status: {
    type: String,
    enum: ['trialing', 'active', 'past_due', 'cancelled'],
    default: 'trialing',
    index: true,
  },
  trialStart: { type: Date, default: null },
  trialEnd: { type: Date, default: null, index: true },
  billingCycle: {
    type: String,
    enum: ['monthly', 'yearly'],
    default: 'monthly',
  },
  // End of the last paid period. Null while trialing/unpaid.
  currentPeriodEnd: { type: Date, default: null, index: true },
  // Billable head-count (owner + active staff) snapshotted at the last
  // pricing event (trial activation or payment).
  staffCount: { type: Number, default: 1, min: 1 },
  // Last successful payment.
  amountPaid: { type: Number, default: 0 },
  currency: { type: String, default: 'KES', uppercase: true, trim: true },
  paymentProvider: { type: String, enum: ['mpesa', 'card', 'bank', null], default: null },
  paymentReference: { type: String, default: null },
  promotion: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Promotion',
    default: null,
  },
  cancelledAt: { type: Date, default: null },
  // Reminder bookkeeping so the cron never double-sends. Keys look like
  // "expiry-7d:2026-08-09" — the reminder kind plus the expiry date it was for.
  remindersSent: { type: [String], default: [] },
  lastReminderSentAt: { type: Date, default: null },
  activatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
}, { timestamps: true });

export default mongoose.model('Subscription', subscriptionSchema);

import mongoose from 'mongoose';

// One accrued mid-period head-count change, awaiting the next invoice.
//
// Seats are postpaid: adding or removing a billable user never takes payment
// on the spot (see seatBillingService). Instead the price difference is
// prorated over what's left of the current period and parked here until
// renewal, which is both fairer than charging a full period for a partial one
// and the reason the mobile app can ship with no purchase flow at all.
const seatAdjustmentSchema = new mongoose.Schema({
  // Head-count before and after, for auditability.
  fromCount: { type: Number, required: true },
  toCount: { type: Number, required: true },
  // What a full period of this change would have cost.
  fullAmount: { type: Number, required: true },
  // What we'll actually bill: fullAmount × the fraction of the period left.
  // Negative for removals (a credit against the next invoice).
  proratedAmount: { type: Number, required: true },
  // 0–1, kept so an invoice line can explain "12 of 30 days".
  fractionRemaining: { type: Number, required: true },
  reason: {
    type: String,
    // 'staff_account_closed' is a seat vacated by the staff member themselves
    // (an approved account closure), kept distinct from 'staff_removed' so an
    // invoice line can say who ended the employment.
    enum: [
      'staff_added',
      'staff_reactivated',
      'staff_deactivated',
      'staff_removed',
      'staff_account_closed',
    ],
    required: true,
  },
  staff: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  staffName: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
}, { _id: true });

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
  // Prorated head-count changes made since the last invoice. Summed into the
  // next renewal amount, then cleared by applySuccessfulPayment.
  seatAdjustments: { type: [seatAdjustmentSchema], default: [] },
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
  // Stacking discount this shop has banked by referring other shops (see
  // Shop.referredByShopId / applySuccessfulPayment), consumed in full on the
  // next successful payment then reset to 0 — never fractioned across
  // multiple future payments.
  referralDiscountPercent: { type: Number, default: 0, min: 0, max: 100 },
  cancelledAt: { type: Date, default: null },
  // Support-granted breathing room, on top of the platform-wide grace period.
  // The lever for "the owner is KES 200 short until Friday" — without it the
  // only options are a global policy change or nothing.
  graceExtensionDays: { type: Number, default: 0, min: 0 },
  graceExtensionGrantedAt: { type: Date, default: null },
  graceExtensionGrantedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null },
  graceExtensionReason: { type: String, default: '', trim: true },
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

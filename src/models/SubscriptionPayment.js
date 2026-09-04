import mongoose from 'mongoose';

// One attempted subscription charge. Provider-agnostic: M-Pesa today, card
// and bank transfer later — providerRef holds whatever id the provider uses
// to correlate its webhook (checkoutRequestId for M-Pesa STK Push).
const subscriptionPaymentSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true,
    index: true,
  },
  subscription: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Subscription',
    required: true,
    index: true,
  },
  plan: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SubscriptionPlan',
    required: true,
  },
  billingCycle: { type: String, enum: ['monthly', 'quarterly', 'yearly'], required: true },
  staffCount: { type: Number, required: true, min: 1 },
  // Always computed server-side by subscriptionPricingService — never client input.
  amount: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'KES', uppercase: true, trim: true },
  // 'free': the server-computed price was covered entirely by a promo/
  // referral discount — no provider was ever charged.
  provider: {
    type: String,
    enum: ['mpesa', 'card', 'bank', 'free'],
    required: true,
  },
  // Provider correlation ids (M-Pesa: CheckoutRequestID / MerchantRequestID).
  providerRef: { type: String, index: true },
  merchantRequestId: { type: String },
  phoneNumber: { type: String },
  status: {
    type: String,
    enum: ['pending', 'success', 'failed', 'cancelled', 'timeout'],
    default: 'pending',
    index: true,
  },
  // Provider receipt on success (M-Pesa receipt number).
  receipt: { type: String },
  transactionDate: { type: Date },
  // The service period this payment covers, set when the charge succeeds.
  periodStart: { type: Date },
  periodEnd: { type: Date },
  promotion: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Promotion',
    default: null,
  },
  promoCode: { type: String, default: null },
  promoDiscount: { type: Number, default: 0 },
  // Snapshot of how much of this payment was covered by the shop's own
  // banked referral credit (Subscription.referralDiscountPercent at the
  // moment this payment was initiated) — mirrors promoDiscount exactly.
  referralDiscount: { type: Number, default: 0 },
  // Error context for failed/cancelled charges.
  resultCode: { type: String },
  errorMessage: { type: String },
  // Raw webhook payload for audit trail.
  callbackPayload: { type: mongoose.Schema.Types.Mixed },
  callbackReceivedAt: { type: Date },
  requestedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  idempotencyKey: { type: String, index: true },
  // What this charge is for. 'seat_addition' payments don't extend the
  // subscription period — they unlock one specific pending staff account
  // (see seatActivationService.js) — while 'subscription' payments are a
  // full renewal/plan-change, handled by applySuccessfulPayment.
  purpose: { type: String, enum: ['subscription', 'seat_addition'], default: 'subscription', index: true },
  // The staff account this seat-addition payment unlocks. Created isActive:false
  // up front (reserves the email, excluded from billable headcount) and flipped
  // to isActive:true only once this payment succeeds.
  pendingStaff: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
}, { timestamps: true });

// Unique idempotency key per shop — sparse so documents without the key are not constrained
subscriptionPaymentSchema.index({ shop: 1, idempotencyKey: 1 }, { unique: true, sparse: true });

export default mongoose.model('SubscriptionPayment', subscriptionPaymentSchema);

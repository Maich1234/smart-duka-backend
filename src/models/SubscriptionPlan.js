import mongoose from 'mongoose';

// A sellable subscription tier. Every number and line of marketing copy the
// app shows on the pricing screen lives here so pricing, promotions, and
// trial length can change without an app release. Managed later from the
// Dukana super-admin page; seeded from constants/subscriptionDefaults.js
// when the collection is empty.
const subscriptionPlanSchema = new mongoose.Schema({
  slug: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  name: { type: String, required: true, trim: true },
  // Short line under the name, e.g. "Perfect for small shops"
  tagline: { type: String, default: '', trim: true },
  description: { type: String, default: '', trim: true },
  // per_staff: monthlyPrice is charged per billable user (owner + staff).
  // flat: monthlyPrice covers the whole shop up to maxStaff.
  billingType: {
    type: String,
    enum: ['per_staff', 'flat'],
    required: true,
  },
  monthlyPrice: { type: Number, required: true, min: 0 },
  // Yearly price is computed as monthly × 12 × (1 − yearlyDiscountPercent/100)
  // unless yearlyPrice is set explicitly.
  yearlyDiscountPercent: { type: Number, default: 20, min: 0, max: 100 },
  yearlyPrice: { type: Number, default: null, min: 0 },
  // Largest team this tier covers. Beyond the top tier's maxStaff, each extra
  // user costs extraStaffPrice per month.
  maxStaff: { type: Number, required: true, min: 1 },
  extraStaffPrice: { type: Number, default: 0, min: 0 },
  trialDays: { type: Number, default: 30, min: 0 },
  currency: { type: String, default: 'KES', uppercase: true, trim: true },
  // Marketing bullets shown on the plan card, in order.
  highlights: { type: [String], default: [] },
  // Machine-readable feature flags this plan enables (inventory, analytics,
  // offline, reports, staff_management, priority_support, ...).
  features: { type: [String], default: [] },
  // e.g. "Recommended" — rendered as a badge on the card.
  badge: { type: String, default: '', trim: true },
  // Relatable price anchor, e.g. "About the cost of a notebook and a pen each month."
  priceComparison: { type: String, default: '', trim: true },
  active: { type: Boolean, default: true },
  displayOrder: { type: Number, default: 0 },
  // Per-tier AI chat quotas — null means unlimited. Enforced server-side by
  // enforceChatLimits (see middlewares/enforceChatLimits.js), not just shown
  // as copy like `features` above.
  chatLimits: {
    maxConversations: { type: Number, default: null, min: 0 },
    maxNewConversationsPerDay: { type: Number, default: null, min: 0 },
    maxMessagesPerDay: { type: Number, default: null, min: 0 },
  },
}, { timestamps: true });

export default mongoose.model('SubscriptionPlan', subscriptionPlanSchema);

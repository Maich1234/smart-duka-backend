import mongoose from 'mongoose';

// A discount code applied at subscription checkout. Redemption is counted
// only when a payment it was attached to succeeds.
const promotionSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true,
  },
  title: { type: String, required: true, trim: true },
  description: { type: String, default: '', trim: true },
  discountType: {
    type: String,
    enum: ['percentage', 'fixed'],
    required: true,
  },
  // percentage: 0–100; fixed: amount in the plan currency (KES).
  discountValue: { type: Number, required: true, min: 0 },
  startsAt: { type: Date, default: null },
  endsAt: { type: Date, default: null },
  maxRedemptions: { type: Number, default: null, min: 1 },
  redemptionCount: { type: Number, default: 0, min: 0 },
  active: { type: Boolean, default: true },
}, { timestamps: true });

/** True if the promotion can be applied right now (dates, cap, active flag). */
promotionSchema.methods.isRedeemable = function isRedeemable(now = new Date()) {
  if (!this.active) return false;
  if (this.startsAt && now < this.startsAt) return false;
  if (this.endsAt && now > this.endsAt) return false;
  if (this.maxRedemptions != null && this.redemptionCount >= this.maxRedemptions) return false;
  return true;
};

export default mongoose.model('Promotion', promotionSchema);

import mongoose from 'mongoose';

// Short-lived OTP session gating admin access to platform-level payment
// credentials (Daraja + Paystack). Unlike PaymentVerificationSession, the
// code is relayed through a separate approver inbox rather than sent to the
// requester — so this session is scoped to the requesting admin, not a shop.
const platformConfigVerificationSessionSchema = new mongoose.Schema({
  requestedByAdminId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AdminUser',
    required: true,
    index: true,
  },
  // bcrypt hash of the 6-digit OTP code
  otpHash: { type: String, required: true },
  // OTP expiry (10 minutes from issuance)
  expiresAt: {
    type: Date,
    required: true,
    default: () => new Date(Date.now() + 10 * 60 * 1000),
  },
  // Failed attempt counter — max 5 before session is invalidated
  attempts: { type: Number, default: 0 },
  isUsed: { type: Boolean, default: false },
  lastAttemptAt: { type: Date },
}, { timestamps: true });

// MongoDB TTL: auto-delete expired sessions
platformConfigVerificationSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('PlatformConfigVerificationSession', platformConfigVerificationSessionSchema);

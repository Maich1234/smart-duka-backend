import mongoose from 'mongoose';

// Short-lived OTP session gating access to sensitive payment configuration.
// Separate from the existing OTP.js (email-verification OTP) to avoid coupling.
const paymentVerificationSessionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  shopId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true,
  },
  method: { type: String, enum: ['sms', 'email'], required: true },
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
  // Masked contact shown to user so they know where the OTP was sent
  sentTo: { type: String },
  lastAttemptAt: { type: Date },
}, { timestamps: true });

// MongoDB TTL: auto-delete expired sessions
paymentVerificationSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('PaymentVerificationSession', paymentVerificationSessionSchema);

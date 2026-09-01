import mongoose from 'mongoose';

// One row per shop signup that redeemed an agent's code — written by
// register.js right after the signup's own transaction commits. `linkedAt`
// stays null until dukana-admin-backend's daily cron creates the matching
// Onboarding row in its own database (see agentReferralLinkService.js
// there); this backend has no connection to write that Onboarding directly.
const agentReferralRedemptionSchema = new mongoose.Schema({
  // No `ref` — Agent lives in the admin backend's own database.
  agentId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  code: { type: String, required: true, trim: true, uppercase: true },
  shopId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true,
    unique: true, // a shop can only ever be onboarded by one agent code
  },
  ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  redeemedAt: { type: Date, default: Date.now },
  linkedAt: { type: Date, default: null },
  // No `ref` — Onboarding lives in the admin backend's own database.
  onboardingId: { type: mongoose.Schema.Types.ObjectId, default: null },
});

export default mongoose.model('AgentReferralRedemption', agentReferralRedemptionSchema);

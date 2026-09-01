import mongoose from 'mongoose';

// Mirror of an Agent's onboarding/referral code (Agent itself lives in
// dukana-admin-backend's own database — see that repo's Agent.js). Written
// there via its secondary connection whenever an agent is created or a
// missing code is lazily backfilled; read here by register.js so a shop
// signup can resolve an agent's code without smart-duka-backend ever needing
// a connection into the admin DB. This backend owns the schema/index for
// this collection even though it's the read side, per the convention
// documented in dukana-admin-backend/src/config/smartDukaDb.js.
const agentReferralCodeSchema = new mongoose.Schema({
  // No `ref` — Agent lives in a different database this connection can't
  // populate() against.
  agentId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
  code: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    uppercase: true,
  },
  // Denormalized display/debug only — not kept in sync beyond creation time.
  agentName: { type: String, trim: true, default: '' },
  active: { type: Boolean, default: true },
}, { timestamps: true });

export default mongoose.model('AgentReferralCode', agentReferralCodeSchema);

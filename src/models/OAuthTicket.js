import mongoose from 'mongoose';

// One document per issued OAuth ticket. Only the SHA-256 hash of the raw
// ticket is stored, same rationale as RefreshToken — a database leak must
// not yield a usable ticket. Two unrelated single-use handoffs share this
// collection rather than getting bespoke stores each, distinguished by
// `kind`:
//   - 'pending_signup': a brand-new Google identity with no matching Dukana
//     account yet, waiting on a "create your shop" step before any User or
//     Shop row is created.
//   - 'mobile_exchange': a resolved Dukana user, waiting for the mobile app
//     to redeem the deep-link handoff for a real session. `payload` here
//     never contains pre-minted tokens — those are minted at claim time.
const oauthTicketSchema = new mongoose.Schema({
  tokenHash: { type: String, required: true, unique: true },
  kind: { type: String, enum: ['pending_signup', 'mobile_exchange'], required: true },
  payload: { type: mongoose.Schema.Types.Mixed, required: true },
  expiresAt: { type: Date, required: true },
  claimedAt: { type: Date, default: null },
});

// Mongo removes expired docs shortly after expiresAt passes.
oauthTicketSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('OAuthTicket', oauthTicketSchema);

import mongoose from 'mongoose';

// One document per issued refresh token. Only the SHA-256 hash is stored —
// a database leak must not yield usable tokens. Rotation chains: using a
// token revokes it and issues a replacement; presenting an already-revoked
// token is treated as theft and revokes every session for that user.
const refreshTokenSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  // Device identity captured at issuance so a staff account's sessions can be
  // enumerated/enforced per-device (owners are exempt from single-session).
  deviceId: { type: String, default: null },
  deviceName: { type: String, default: null },
  platform: { type: String, enum: ['ios', 'android', 'web', null], default: null },
  // Why this doc stopped being usable — distinguishes intentional revocation
  // (supersession/admin/logout/password change) from a genuine replayed
  // token, which is what tells rotateRefreshToken whether to treat reuse as
  // theft (cascade-revoke everything) or as an expected stale-device retry.
  revokedReason: {
    type: String,
    enum: ['rotated', 'manual_logout', 'superseded_by_new_device', 'admin_force_logout', 'password_change', 'token_reuse_detected', null],
    default: null,
  },
});

// Mongo removes expired docs shortly after expiresAt passes.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('RefreshToken', refreshTokenSchema);

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
});

// Mongo removes expired docs shortly after expiresAt passes.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('RefreshToken', refreshTokenSchema);

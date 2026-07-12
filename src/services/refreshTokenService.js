import crypto from 'crypto';
import RefreshToken from '../models/RefreshToken.js';

// 30-day sliding window: every rotation issues a fresh 30-day token, so an
// actively-used shop device stays signed in indefinitely while an abandoned
// one expires.
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

/** Issues a new refresh token for a user. Returns the RAW token (only time it exists in plaintext). */
export const issueRefreshToken = async (userId) => {
  const raw = crypto.randomBytes(48).toString('hex');
  await RefreshToken.create({
    user: userId,
    tokenHash: hashToken(raw),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  });
  return raw;
};

export class RefreshTokenError extends Error {
  constructor(message) {
    super(message);
    this.status = 401;
  }
}

/**
 * Validates + rotates a refresh token: the presented token is revoked and a
 * replacement issued atomically enough for the single-client mobile flow.
 * Reuse of an already-revoked token means the token leaked (or a very stale
 * client) — revoke the user's every session and force re-login.
 */
export const rotateRefreshToken = async (raw) => {
  if (!raw || typeof raw !== 'string' || raw.length > 256) {
    throw new RefreshTokenError('Invalid refresh token');
  }
  const tokenHash = hashToken(raw);

  // Atomic claim: only one concurrent request can rotate a given token.
  const doc = await RefreshToken.findOneAndUpdate(
    { tokenHash, revokedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { revokedAt: new Date() } }
  );

  if (!doc) {
    const spent = await RefreshToken.findOne({ tokenHash });
    if (spent) {
      // Replay of a revoked token — kill the whole session family.
      await RefreshToken.updateMany(
        { user: spent.user, revokedAt: null },
        { $set: { revokedAt: new Date() } }
      );
    }
    throw new RefreshTokenError('Session expired. Please sign in again.');
  }

  const newRaw = await issueRefreshToken(doc.user);
  return { userId: doc.user, refreshToken: newRaw };
};

/** Best-effort revocation on logout. Unknown tokens are ignored. */
export const revokeRefreshToken = async (raw) => {
  if (!raw || typeof raw !== 'string') return;
  await RefreshToken.updateOne(
    { tokenHash: hashToken(raw), revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
};

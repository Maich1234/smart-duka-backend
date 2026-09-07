import crypto from 'crypto';
import OAuthTicket from '../models/OAuthTicket.js';

const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

export class OAuthTicketError extends Error {
  constructor(message = 'This link has expired or was already used. Please try again.', code = 'TICKET_INVALID') {
    super(message);
    this.status = 400;
    this.code = code;
  }
}

/** Issues a single-use ticket. Returns the RAW token (only time it exists in plaintext). */
export const issueTicket = async ({ kind, payload, ttlMs }) => {
  const raw = crypto.randomBytes(32).toString('hex');
  await OAuthTicket.create({
    tokenHash: hashToken(raw),
    kind,
    payload,
    expiresAt: new Date(Date.now() + ttlMs),
  });
  return raw;
};

/**
 * Atomically claims a ticket: only one caller can ever successfully redeem
 * a given raw token, matching the same findOneAndUpdate-claim pattern
 * refreshTokenService.rotateRefreshToken uses for exactly the same reason —
 * a double-tap or retried request must not be redeemable twice (no second
 * shop created, no second token pair minted).
 */
export const claimTicket = async (raw, kind) => {
  if (!raw || typeof raw !== 'string' || raw.length > 256) {
    throw new OAuthTicketError();
  }
  const doc = await OAuthTicket.findOneAndUpdate(
    { tokenHash: hashToken(raw), kind, claimedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { claimedAt: new Date() } }
  );
  if (!doc) {
    throw new OAuthTicketError();
  }
  return doc.payload;
};

import crypto from 'crypto';

// Excludes 0/O/1/I/L — characters that are easy to misread or mistype when a
// code is read aloud or copied off a printed flyer, which is exactly how a
// referral code gets shared.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

/** One random candidate code. Not guaranteed unique — callers check. */
export function generateReferralCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += ALPHABET[crypto.randomInt(ALPHABET.length)];
  }
  return code;
}

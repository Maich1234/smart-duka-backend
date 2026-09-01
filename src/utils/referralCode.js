import ReferralCodeCounter from '../models/ReferralCodeCounter.js';

// Excludes 0/O/1/I/L — characters that are easy to misread or mistype when a
// code is read aloud or copied off a printed flyer, which is exactly how a
// referral code gets shared. DIGITS additionally excludes 0/1 for the same
// reason and is used only for the mandatory-digit slot (position 3).
const ALNUM = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 31 symbols
const DIGITS = '23456789'; // 8 symbols

// dukana-admin-backend/src/utils/referralCode.js is a deliberate duplicate of
// this file (Agent lives in a separate database — see that file's own header
// comment). Keep the two in lockstep: any change to the alphabet or encoding
// below must be mirrored there, or codes issued by the two backends could
// stop being disjoint.

/**
 * Encodes a zero-based sequence number into a 6-character referral code:
 * [type][alnum][digit][alnum][alnum][alnum]. `typeChar` is a fixed literal
 * per issuer ('S' shop, 'E' staff) so the code spaces of different issuers
 * never collide with each other by construction — only calls with the same
 * typeChar need distinct `n`. The 3rd character is always a digit.
 *
 * This is a bijective mixed-radix encoding: every `n` maps to exactly one
 * code and no two values of `n` ever collide, so uniqueness is a property of
 * the encoding, not a database check. Capacity is 31^4 * 8 = 7,388,168 codes
 * per type — widening to 7 characters later (one more ALNUM digit) is
 * additive if that's ever approached.
 */
export function encodeReferralCode(typeChar, n) {
  let rest = n;
  const digitIdx = rest % DIGITS.length;
  rest = Math.floor(rest / DIGITS.length);
  const c1 = ALNUM[rest % ALNUM.length];
  rest = Math.floor(rest / ALNUM.length);
  const c3 = ALNUM[rest % ALNUM.length];
  rest = Math.floor(rest / ALNUM.length);
  const c4 = ALNUM[rest % ALNUM.length];
  rest = Math.floor(rest / ALNUM.length);
  const c5 = ALNUM[rest % ALNUM.length];
  rest = Math.floor(rest / ALNUM.length);
  if (rest > 0) {
    throw new Error(`Referral code space exhausted for type "${typeChar}" (n=${n})`);
  }
  return `${typeChar}${c1}${DIGITS[digitIdx]}${c3}${c4}${c5}`;
}

/**
 * Claims the next referral code for a given type via one atomic $inc —
 * same "no read-then-write window" guarantee nextInvoiceNumber gives Shop's
 * invoiceSeq. `CounterModel` is injectable for unit tests.
 */
export async function nextReferralCode(typeChar, counterKey, { CounterModel = ReferralCodeCounter } = {}) {
  const counter = await CounterModel.findOneAndUpdate(
    { _id: counterKey },
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  );
  return encodeReferralCode(typeChar, counter.seq - 1);
}

export const generateShopReferralCode = () => nextReferralCode('S', 'shop_referral_code');
export const generateStaffReferralCode = () => nextReferralCode('E', 'staff_referral_code');

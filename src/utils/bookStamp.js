import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { PUBLIC_WEB_URL } from './publicWebUrl.js';

/**
 * Authenticity stamp for a generated book.
 *
 * This attests **origin and integrity**, not accuracy: that DuQana
 * produced this document, for this shop and period, with these totals, and
 * that none of it has been altered since. It is deliberately not an audit
 * opinion — the P&L's own footnotes say it isn't an IFRS statement, and a
 * badge implying assurance would contradict them.
 *
 * Stateless, following utils/receiptToken.js: nothing is persisted. Where a
 * receipt token carries only an id for the server to look up, a book has
 * nothing stored to look up — so the token carries the attested figures
 * themselves. That is what lets a verifier compare the numbers printed on a
 * PDF against the numbers DuQana signed, and see a doctored document for
 * what it is.
 *
 * No expiry. Financial records must stay verifiable for years.
 */

const PURPOSE = 'book_stamp';

/** Falls back to JWT_SECRET so this needs no new environment configuration. */
const secret = () => process.env.RECEIPT_TOKEN_SECRET || process.env.JWT_SECRET;

/**
 * A short code a human can read aloud or type. Derived from the signature, so
 * it changes if any attested figure changes.
 */
const documentIdFrom = (token) =>
  crypto
    .createHash('sha256')
    .update(token)
    .digest('hex')
    .slice(0, 12)
    .toUpperCase()
    .replace(/(.{4})(.{4})(.{4})/, '$1-$2-$3');

/**
 * Signs the facts that make this document what it is. Totals are included so
 * editing a figure in a PDF editor makes the printed document disagree with
 * its own stamp.
 */
export function signBookStamp({ shopId, shopName, key, title, from, to, generatedAt, totals }) {
  const payload = {
    p: PURPOSE,
    s: String(shopId),
    n: shopName,
    k: key,
    t: title,
    f: from,
    e: to,
    g: generatedAt,
    v: totals,
  };
  const token = jwt.sign(payload, secret(), { noTimestamp: true });
  return { token, documentId: documentIdFrom(token) };
}

/** Returns the attested facts, or null if the token is forged or altered. */
export function verifyBookStamp(token) {
  try {
    const decoded = jwt.verify(token, secret());
    if (decoded.p !== PURPOSE) return null;
    return {
      shopId: decoded.s,
      shopName: decoded.n,
      key: decoded.k,
      title: decoded.t,
      from: decoded.f,
      to: decoded.e,
      generatedAt: decoded.g,
      totals: decoded.v ?? {},
      documentId: documentIdFrom(token),
    };
  } catch {
    return null;
  }
}

/** Where a QR on the document points. */
export const bookVerifyUrl = (token) => `${PUBLIC_WEB_URL}/verify/${token}`;

import jwt from 'jsonwebtoken';

const PURPOSE = 'setup_guide';
const EXPIRES_IN = '10m';

/**
 * Short-lived, single-purpose token handed to the mobile app's embedded
 * WebView so a stripped web page (no login of its own) can fetch this shop's
 * setup status. Deliberately narrower than a normal session token: it only
 * carries `shop` + `purpose`, expires in 10 minutes, and is only ever
 * accepted by GET /setup/status — never treated as a general bearer token.
 */
export const signWebviewToken = (shopId) =>
  jwt.sign({ shop: shopId.toString(), purpose: PURPOSE }, process.env.JWT_SECRET, { expiresIn: EXPIRES_IN });

/** Returns the shopId if the token is valid, unexpired, and carries the expected purpose — otherwise null. */
export const verifyWebviewToken = (token) => {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.purpose !== PURPOSE || !decoded.shop) return null;
    return decoded.shop;
  } catch {
    return null;
  }
};

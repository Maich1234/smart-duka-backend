import crypto from 'crypto';
import generateToken from '../utils/generateToken.js';
import { issueRefreshToken, REFRESH_TOKEN_TTL_MS } from './refreshTokenService.js';

// Kept independent of JWT_EXPIRES_IN's exact string (parsing '1h'/'15m'/etc.
// isn't worth a dependency for a cookie's Max-Age, which is only a browser
// housekeeping hint anyway — jwt.verify's own exp check is what actually
// enforces expiry regardless of how long the cookie itself sticks around).
// Update this if JWT_EXPIRES_IN's default changes.
const ACCESS_TOKEN_COOKIE_MAX_AGE_MS = 60 * 60 * 1000;

const isProd = process.env.NODE_ENV === 'production';
// Web (duqana.co.ke) and the API (a vercel.app domain) are different
// registrable domains — a deliberate choice to stay on Vercel's domain
// rather than provision a custom api.* subdomain — so this is a genuinely
// cross-site relationship, not same-site. SameSite=Lax cookies are never
// sent on cross-site XHR/fetch at all, so the default here must be 'none'
// in any deployed environment; local dev (both sides on localhost, which
// counts as same-site regardless of port) is the one place 'lax' still
// works and is preferable there. Because of this, the CSRF double-submit
// check and the Origin allowlist (csrf.js) are load-bearing here, not
// defense-in-depth — SameSite isn't blocking anything on its own.
const SAME_SITE = process.env.WEB_COOKIE_SAMESITE || (isProd ? 'none' : 'lax');
// SameSite=None is rejected by browsers unless Secure is also set,
// regardless of NODE_ENV.
const SECURE = isProd || SAME_SITE === 'none';
// Scoped to the auth routes only, so the refresh token isn't sent (even
// though it's HttpOnly and unreadable by JS) on every unrelated API call —
// it's only ever needed by /auth/refresh and /auth/logout.
const AUTH_COOKIE_PATH = '/api/v1/auth';

function baseCookieAttrs({ path = '/', httpOnly = true } = {}) {
  return { httpOnly, secure: SECURE, sameSite: SAME_SITE, path };
}

/**
 * Transports an already-minted access token (and, for a full session, a
 * refresh token) to the client the way that platform expects: HttpOnly
 * cookies for web — tokens never enter the response body — or the existing
 * JSON body shape for everything else (mobile).
 *
 * Deliberately takes already-minted tokens rather than minting its own:
 * the refresh endpoint has already rotated one via rotateRefreshToken, and
 * calling this with a fresh mint on top would silently orphan a second,
 * untracked-by-the-client refresh token. Callers that need a brand-new
 * session (login, OAuth) should use issueSessionResponse below instead.
 */
export const sendSessionCredentials = (res, { platform, accessToken, refreshToken, extra = {} }) => {
  if (platform === 'web') {
    res.cookie('access_token', accessToken, { ...baseCookieAttrs(), maxAge: ACCESS_TOKEN_COOKIE_MAX_AGE_MS });
    if (refreshToken) {
      res.cookie('refresh_token', refreshToken, { ...baseCookieAttrs({ path: AUTH_COOKIE_PATH }), maxAge: REFRESH_TOKEN_TTL_MS });
    }
    // Not HttpOnly — the frontend reads this and mirrors it into
    // X-CSRF-Token on mutating requests (double-submit pattern). It carries
    // no secret; its only job is proving a request came from our own
    // same-origin JS, not a form/fetch on another site riding the ambient
    // session cookie.
    res.cookie('csrf_token', crypto.randomBytes(24).toString('hex'), { ...baseCookieAttrs({ httpOnly: false }), maxAge: REFRESH_TOKEN_TTL_MS });
    return res.json({ success: true, data: { ...extra } });
  }

  return res.json({ success: true, data: { ...extra, token: accessToken, ...(refreshToken ? { refreshToken } : {}) } });
};

/** Mints a brand-new session (fresh access + refresh token pair) and sends it. */
export const issueSessionResponse = async (res, { user, platform, device, extra = {} }) => {
  const accessToken = generateToken(user._id);
  const refreshToken = await issueRefreshToken(user._id, device);
  return sendSessionCredentials(res, { platform, accessToken, refreshToken, extra });
};

/**
 * Sets only the access-token cookie (plus a fresh CSRF cookie so the session
 * can still make mutating requests) for a caller-supplied token — no refresh
 * token is issued or stored. Used solely to redeem admin impersonation's
 * bounded, non-renewable one-time JWT into a cookie: minting a real refresh
 * session here would defeat the "dies on its own, no silent renewal"
 * property that token deliberately has (see internal/impersonationController.js).
 */
export const setWebAccessOnlyCookie = (res, { accessToken, maxAgeMs }) => {
  res.cookie('access_token', accessToken, { ...baseCookieAttrs(), maxAge: maxAgeMs });
  res.cookie('csrf_token', crypto.randomBytes(24).toString('hex'), { ...baseCookieAttrs({ httpOnly: false }), maxAge: maxAgeMs });
};

export const clearSessionCookies = (res) => {
  res.clearCookie('access_token', baseCookieAttrs());
  res.clearCookie('refresh_token', baseCookieAttrs({ path: AUTH_COOKIE_PATH }));
  res.clearCookie('csrf_token', baseCookieAttrs({ httpOnly: false }));
};

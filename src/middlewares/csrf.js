function getAllowlist() {
  return (process.env.CORS_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function requestOrigin(req) {
  const raw = req.headers.origin || req.headers.referer;
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * Rejects a request whose Origin/Referer isn't one of our own frontends.
 * Applied to login/register, which run before any session cookie exists —
 * so the double-submit check below can't apply yet — to block "login CSRF":
 * a blind cross-site POST (fetch with mode:'no-cors', or a bare HTML form)
 * that logs a victim's browser into an attacker's account. CORS alone
 * doesn't stop this: it only blocks a page's JS from *reading* a
 * cross-origin response, not from firing a request that still reaches the
 * server and still gets its Set-Cookie honored.
 *
 * A request with no Origin/Referer header at all (native mobile clients
 * don't send either) is allowed through — this check exists to catch
 * browser-originated cross-site requests, not to gate non-browser clients.
 *
 * No-ops if CORS_ALLOWED_ORIGINS isn't configured (local dev).
 */
export const requireAllowedOrigin = (req, res, next) => {
  const allowlist = getAllowlist();
  if (allowlist.length === 0) return next();

  const origin = requestOrigin(req);
  if (origin === null) return next();
  if (!allowlist.includes(origin)) {
    return res.status(403).json({ success: false, message: 'Request rejected.' });
  }
  next();
};

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Double-submit CSRF defense for cookie-authenticated requests: the
 * non-HttpOnly csrf_token cookie can only be read and echoed back into a
 * header by our own same-origin JS — a cross-site form or fetch riding the
 * ambient session cookie has no way to read it. A no-op for
 * Bearer-authenticated (mobile) requests, which carry no ambient browser
 * credential for a cross-site request to ride on in the first place.
 */
export const verifyCsrf = (req, res, next) => {
  const usesCookieAuth = Boolean(req.cookies?.access_token || req.cookies?.refresh_token);
  if (!usesCookieAuth || !MUTATING_METHODS.has(req.method)) {
    return next();
  }

  const allowlist = getAllowlist();
  if (allowlist.length > 0) {
    const origin = requestOrigin(req);
    if (origin !== null && !allowlist.includes(origin)) {
      return res.status(403).json({ success: false, message: 'Request rejected.' });
    }
  }

  const headerToken = req.headers['x-csrf-token'];
  const cookieToken = req.cookies?.csrf_token;
  if (!headerToken || !cookieToken || headerToken !== cookieToken) {
    return res.status(403).json({ success: false, message: 'Request rejected.' });
  }
  next();
};

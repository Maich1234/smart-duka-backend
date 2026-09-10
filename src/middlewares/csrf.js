export function getAllowlist() {
  return (process.env.CORS_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function requestOrigin(req) {
  const raw = req.headers.origin || req.headers.referer;
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    // Present but unparseable — e.g. the literal string "null", which
    // browsers send as a real Origin header for an opaque-origin request
    // (a sandboxed iframe or a data: URL). That's still a browser request
    // with an untrustworthy origin, not the absence of one, so it must not
    // fall through to isOriginAllowed's no-Origin-header "native client"
    // allowance — return the raw value so it gets rejected like any other
    // origin that isn't on the allowlist.
    return raw;
  }
}

/**
 * The single "is this browser Origin one of ours" decision — shared by CORS
 * (app.js), requireAllowedOrigin, and verifyCsrf below, so there's one copy
 * of this logic rather than three that could quietly drift apart.
 *
 * A falsy origin (no Origin/Referer header at all) always passes: that's a
 * native client or server-to-server call, not a browser request, and none
 * of these checks exist to gate those — CORS itself is a browser-only
 * mechanism.
 *
 * An empty allowlist is a legitimate local-dev convenience (nothing
 * configured to check against yet) but a dangerous default in a real
 * deployment: with cookie sessions live, silently allowing every origin
 * through with credentials is what makes CORS reflection and login-CSRF
 * actually exploitable. Production fails CLOSED instead.
 */
export function isOriginAllowed(origin) {
  if (!origin) return true;
  const allowlist = getAllowlist();
  if (allowlist.length === 0) return process.env.NODE_ENV !== 'production';
  return allowlist.includes(origin);
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
 */
export const requireAllowedOrigin = (req, res, next) => {
  if (isOriginAllowed(requestOrigin(req))) return next();
  res.status(403).json({ success: false, message: 'Request rejected.' });
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

  if (!isOriginAllowed(requestOrigin(req))) {
    return res.status(403).json({ success: false, message: 'Request rejected.' });
  }

  const headerToken = req.headers['x-csrf-token'];
  const cookieToken = req.cookies?.csrf_token;
  if (!headerToken || !cookieToken || headerToken !== cookieToken) {
    return res.status(403).json({ success: false, message: 'Request rejected.' });
  }
  next();
};

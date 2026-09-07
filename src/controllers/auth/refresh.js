import User from '../../models/User.js';
import generateToken from '../../utils/generateToken.js';
import {
  rotateRefreshToken,
  revokeRefreshToken,
  RefreshTokenError,
} from '../../services/refreshTokenService.js';
import { sendSessionCredentials, clearSessionCookies } from '../../services/sessionResponse.js';

/**
 * POST /auth/refresh  { refreshToken }  (mobile)  |  refresh_token cookie (web)
 * Rotates the refresh token and returns a fresh access token. The old
 * refresh token is dead after this call. Web never sends a body here — the
 * cookie's mere presence is what identifies the request as web, since a
 * mobile client has no cookie jar to have populated one from.
 */
export const refresh = async (req, res) => {
  const isWeb = Boolean(req.cookies?.refresh_token);
  const rawRefreshToken = isWeb ? req.cookies.refresh_token : req.body?.refreshToken;

  try {
    const { userId, refreshToken } = await rotateRefreshToken(rawRefreshToken);

    // Deactivated / deleted accounts must not be able to mint access tokens.
    const user = await User.findById(userId).select('isActive');
    if (!user || !user.isActive) {
      if (isWeb) clearSessionCookies(res);
      return res.status(401).json({ success: false, message: 'Account is no longer active.' });
    }

    sendSessionCredentials(res, {
      platform: isWeb ? 'web' : 'mobile',
      accessToken: generateToken(userId),
      refreshToken,
    });
  } catch (err) {
    if (err instanceof RefreshTokenError) {
      if (isWeb) clearSessionCookies(res);
      return res.status(401).json({ success: false, message: err.message, code: err.code });
    }
    throw err;
  }
};

/**
 * POST /auth/logout  { refreshToken }  (mobile)  |  refresh_token cookie (web)
 * Best-effort revocation. Deliberately unauthenticated: the access token may
 * already be expired at logout time, and possession of the refresh token is
 * exactly the authority needed to revoke it.
 */
export const logout = async (req, res) => {
  const isWeb = Boolean(req.cookies?.refresh_token);
  const rawRefreshToken = isWeb ? req.cookies.refresh_token : req.body?.refreshToken;
  await revokeRefreshToken(rawRefreshToken, 'manual_logout');
  if (isWeb) clearSessionCookies(res);
  res.json({ success: true, message: 'Logged out' });
};

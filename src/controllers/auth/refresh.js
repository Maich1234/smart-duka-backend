import User from '../../models/User.js';
import generateToken from '../../utils/generateToken.js';
import {
  rotateRefreshToken,
  revokeRefreshToken,
  RefreshTokenError,
} from '../../services/refreshTokenService.js';

/**
 * POST /auth/refresh  { refreshToken }
 * Rotates the refresh token and returns a fresh access token. The old
 * refresh token is dead after this call — clients must store the new one.
 */
export const refresh = async (req, res) => {
  try {
    const { userId, refreshToken } = await rotateRefreshToken(req.body?.refreshToken);

    // Deactivated / deleted accounts must not be able to mint access tokens.
    const user = await User.findById(userId).select('isActive');
    if (!user || !user.isActive) {
      return res.status(401).json({ success: false, message: 'Account is no longer active.' });
    }

    res.json({
      success: true,
      data: { token: generateToken(userId), refreshToken },
    });
  } catch (err) {
    if (err instanceof RefreshTokenError) {
      return res.status(401).json({ success: false, message: err.message });
    }
    throw err;
  }
};

/**
 * POST /auth/logout  { refreshToken }
 * Best-effort revocation. Deliberately unauthenticated: the access token may
 * already be expired at logout time, and possession of the refresh token is
 * exactly the authority needed to revoke it.
 */
export const logout = async (req, res) => {
  await revokeRefreshToken(req.body?.refreshToken);
  res.json({ success: true, message: 'Logged out' });
};

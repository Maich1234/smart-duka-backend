import jwt from 'jsonwebtoken';
import User from '../../models/User.js';
import { logAudit } from '../../services/auditLogService.js';
import { setWebAccessOnlyCookie } from '../../services/sessionResponse.js';

/**
 * POST /auth/impersonation/redeem  { token }
 * The web-cookie-era replacement for dukana-admin-web's bridge page writing
 * the one-time impersonation JWT (see
 * internal/impersonationController.js) straight into localStorage. Takes
 * that same short-lived, no-refresh-token JWT and puts it in an HttpOnly
 * cookie instead — deliberately NOT a full session mint: issuing a real
 * 30-day refresh token here would defeat the bounded, non-renewable window
 * impersonation is supposed to have.
 */
export const redeemImpersonationToken = async (req, res) => {
  const { token } = req.body || {};
  if (!token) {
    return res.status(400).json({ success: false, message: 'Missing session link.' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ success: false, message: 'This session link has expired or is invalid.' });
  }
  if (!decoded.impersonation) {
    return res.status(401).json({ success: false, message: 'This session link has expired or is invalid.' });
  }

  const user = await User.findById(decoded.id).select('-password').populate('shop');
  if (!user || !user.isActive) {
    return res.status(401).json({ success: false, message: 'This session link has expired or is invalid.' });
  }

  const maxAgeMs = Math.max(0, decoded.exp * 1000 - Date.now());
  setWebAccessOnlyCookie(res, { accessToken: token, maxAgeMs });

  const userResponse = user.toObject();
  delete userResponse.password;
  res.json({ success: true, data: userResponse });
};

/**
 * POST /auth/impersonation/end — logs the end of an admin support session.
 * No-op (still 200) for a normal, non-impersonated session, so the web app
 * can call this unconditionally from its logout path.
 */
export const endImpersonation = async (req, res) => {
  if (req.impersonation) {
    await logAudit({
      shopId: req.user.shop._id,
      userId: req.user._id,
      action: 'auth.impersonation_ended',
      entityType: 'User',
      entityId: req.user._id,
      details: { adminId: req.impersonation.adminId },
      req,
    });
  }
  res.json({ success: true });
};

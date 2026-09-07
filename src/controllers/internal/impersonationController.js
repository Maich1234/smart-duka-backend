import jwt from 'jsonwebtoken';
import User from '../../models/User.js';
import { logAudit } from '../../services/auditLogService.js';

// 15 minutes, no refresh token issued — a bounded support window that dies on
// its own rather than silently extending via the normal refresh flow.
const IMPERSONATION_TOKEN_TTL_SECONDS = 15 * 60;

/**
 * POST /internal/impersonation-token — service-to-service only (dukana-admin-backend).
 * Mints a short-lived access token for an existing shop user so an admin can
 * open the web app already logged in as them, for support. No RefreshToken is
 * created, so the session cannot be silently extended past its TTL.
 */
export const mintImpersonationToken = async (req, res) => {
  const { userId, adminId, adminEmail, reason } = req.body;
  if (!userId || !adminId) {
    return res.status(400).json({ success: false, message: 'userId and adminId are required' });
  }

  const user = await User.findById(userId).populate('shop');
  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }
  if (!user.isActive) {
    return res.status(403).json({ success: false, message: 'Account deactivated' });
  }

  const token = jwt.sign(
    { id: user._id, impersonation: true, adminId },
    process.env.JWT_SECRET,
    { expiresIn: IMPERSONATION_TOKEN_TTL_SECONDS }
  );

  await logAudit({
    shopId: user.shop._id,
    userId: user._id,
    action: 'auth.impersonation_started',
    entityType: 'User',
    entityId: user._id,
    details: { adminId, adminEmail, reason },
    req,
  });

  res.json({
    success: true,
    data: {
      token,
      expiresIn: IMPERSONATION_TOKEN_TTL_SECONDS,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        shopId: user.shop._id,
      },
    },
  });
};

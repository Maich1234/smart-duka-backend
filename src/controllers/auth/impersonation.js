import { logAudit } from '../../services/auditLogService.js';

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

import SupportSession from '../../models/SupportSession.js';
import { logAudit } from '../../services/auditLogService.js';

/**
 * POST /auth/impersonation/end — revokes and audits an admin support session.
 * No-op (still 200) for a normal, non-impersonated session, so the web app
 * can call this unconditionally from its logout path.
 */
export const endImpersonation = async (req, res) => {
  if (req.impersonation) {
    const result = await SupportSession.updateOne(
      { _id: req.impersonation.sessionId, endedAt: null },
      { $set: { endedAt: new Date() } },
    );
    if (!result.modifiedCount) return res.json({ success: true });
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

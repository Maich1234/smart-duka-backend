import { requestPlatformConfigVerification, verifyPlatformConfigCode } from '../services/platformConfigVerificationService.js';
import { logAudit } from '../services/auditLogService.js';

export const requestVerification = async (req, res) => {
  try {
    const admin = req.admin;

    const { sessionId } = await requestPlatformConfigVerification(admin);

    logAudit({
      action: 'admin.platform_config.verification_requested',
      details: { adminId: String(admin._id), adminEmail: admin.email },
      req,
    }).catch(() => {});

    return res.json({
      success: true,
      data: { sessionId },
      message: 'A verification code has been sent to the platform security approver.',
    });
  } catch (err) {
    console.error('[AdminPlatformConfigVerification] requestVerification error:', err);

    if (err.transient) {
      return res.status(503).json({
        success: false,
        message: err.message,
      });
    }

    const message = err.message?.includes('rate limit') || err.message?.includes('Too many')
      ? 'Too many verification requests. Please wait a few minutes and try again.'
      : err.message?.includes('approver')
        ? err.message
        : err.message?.includes('email')
          ? `Failed to send verification code: ${err.message}`
          : 'Failed to send verification code. Please try again.';
    return res.status(err.statusCode ?? 500).json({ success: false, message });
  }
};

export const verifyCode = async (req, res) => {
  try {
    const { sessionId, code } = req.body;
    const admin = req.admin;

    const verificationToken = await verifyPlatformConfigCode(sessionId, code, admin._id);

    logAudit({
      action: 'admin.platform_config.verification_verified',
      details: { adminId: String(admin._id), adminEmail: admin.email },
      req,
    }).catch(() => {});

    return res.json({
      success: true,
      data: { verificationToken },
      message: 'Verified successfully.',
    });
  } catch (err) {
    console.error('[AdminPlatformConfigVerification] verifyCode error:', err);
    const message = err.message?.includes('Invalid') || err.message?.includes('expired') || err.message?.includes('incorrect')
      ? err.message
      : 'Verification failed. Please try again.';
    return res.status(err.statusCode ?? 400).json({ success: false, message });
  }
};

import { requestOTP, verifyOTP } from '../services/otpService.js';
import { logAudit } from '../services/auditLogService.js';

export const requestVerificationOTP = async (req, res) => {
  try {
    const { method } = req.body;
    const user = req.user;

    const { sessionId, sentTo } = await requestOTP(user, method);

    logAudit({
      shopId: user.shop._id ?? user.shop,
      userId: user._id,
      action: 'otp.requested',
      details: { method, sentTo },
      req,
    }).catch(() => {});

    return res.json({
      success: true,
      data: { sessionId, sentTo, method },
      message: `Verification code sent to ${sentTo}`,
    });
  } catch (err) {
    console.error('[OTP] requestVerificationOTP error:', err);

    // The delivery channel is down rather than the request being wrong — say so,
    // and point the owner at the other channel if it's available to them.
    if (err.transient) {
      const canFallBack = req.body.method === 'email' && req.user?.phone;
      return res.status(503).json({
        success: false,
        message: canFallBack
          ? 'Email delivery is temporarily unavailable. Please try SMS verification instead.'
          : err.message,
      });
    }

    const message = err.message?.includes('rate limit') || err.message?.includes('Too many')
      ? 'Too many verification requests. Please wait a few minutes and try again.'
      : err.message?.includes('email') || err.message?.includes('SMS')
        ? `Failed to send verification code: ${err.message}`
        : 'Failed to send verification code. Please try again.';
    return res.status(err.statusCode ?? 500).json({ success: false, message });
  }
};

export const verifyVerificationOTP = async (req, res) => {
  try {
    const { sessionId, code } = req.body;
    const user = req.user;

    const verificationToken = await verifyOTP(sessionId, code, user._id);

    logAudit({
      shopId: user.shop._id ?? user.shop,
      userId: user._id,
      action: 'otp.verified',
      req,
    }).catch(() => {});

    return res.json({
      success: true,
      data: { verificationToken },
      message: 'Identity verified successfully.',
    });
  } catch (err) {
    console.error('[OTP] verifyVerificationOTP error:', err);
    const message = err.message?.includes('Invalid') || err.message?.includes('expired') || err.message?.includes('incorrect')
      ? err.message
      : 'Verification failed. Please try again.';
    return res.status(err.statusCode ?? 400).json({ success: false, message });
  }
};

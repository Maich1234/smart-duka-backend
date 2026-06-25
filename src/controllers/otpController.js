import { requestOTP, verifyOTP } from '../services/otpService.js';
import { logAudit } from '../services/auditLogService.js';

export const requestVerificationOTP = async (req, res) => {
  const { method } = req.body;
  const user = req.user;

  const { sessionId, sentTo } = await requestOTP(user, method);

  await logAudit({
    shopId: user.shop._id ?? user.shop,
    userId: user._id,
    action: 'otp.requested',
    details: { method, sentTo },
    req,
  });

  res.json({
    success: true,
    data: { sessionId, sentTo, method },
    message: `Verification code sent to ${sentTo}`,
  });
};

export const verifyVerificationOTP = async (req, res) => {
  const { sessionId, code } = req.body;
  const user = req.user;

  const verificationToken = await verifyOTP(sessionId, code, user._id);

  await logAudit({
    shopId: user.shop._id ?? user.shop,
    userId: user._id,
    action: 'otp.verified',
    req,
  });

  res.json({
    success: true,
    data: { verificationToken },
    message: 'Identity verified successfully.',
  });
};

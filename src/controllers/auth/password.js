import User from '../../models/User.js';
import OTP from '../../models/OTP.js';
import { generateOTP } from '../../utils/generateOTP.js';
import { sendOTPEmail } from '../../utils/email.js';
import { revokeAllSessions } from '../../services/refreshTokenService.js';
import { logAudit } from '../../services/auditLogService.js';

export const changePassword = async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = await User.findById(req.user._id);
  const isMatch = await user.comparePassword(currentPassword);
  if (!isMatch) {
    return res.status(401).json({ success: false, message: 'Current password is incorrect' });
  }

  user.password = newPassword;
  await user.save();

  // A changed password should end every other device's session too — the
  // old password is exactly what an unauthorized device would still have.
  await revokeAllSessions(user._id, 'password_change');
  await logAudit({ shopId: user.shop, userId: user._id, action: 'auth.password_change', entityType: 'RefreshToken', req });

  res.json({ success: true, message: 'Password changed successfully' });
};

export const forgotPassword = async (req, res) => {
  const { email } = req.body;

  const user = await User.findOne({ email });
  if (!user) {
    return res.status(404).json({ success: false, message: 'No account found with that email' });
  }

  await OTP.deleteMany({ email });

  const otp = generateOTP();
  await OTP.create({ email, otp, expiresAt: new Date(Date.now() + 10 * 60 * 1000) });

  // A failed send here must not read as a generic server fault: the OTP is the
  // only way through this flow, so the user needs to know the code is not coming
  // and that retrying is worthwhile. The stored OTP is left in place — it stays
  // valid if a retry succeeds within its 10-minute window.
  try {
    await sendOTPEmail(email, otp, user.name);
  } catch (err) {
    console.error('[forgotPassword] OTP email failed for', email, '-', err.message);
    return res.status(503).json({
      success: false,
      message: 'We could not send the reset code right now. Please try again in a few minutes.',
    });
  }

  res.status(200).json({ success: true, message: 'OTP sent to your email' });
};

export const verifyOTP = async (req, res) => {
  const { email, otp } = req.body;
  
  const otpRecord = await OTP.findOne({ email, otp });
  if (!otpRecord) {
    return res.status(400).json({ success: false, message: 'Invalid OTP' });
  }

  if (otpRecord.expiresAt < new Date()) {
    await OTP.deleteOne({ _id: otpRecord._id });
    return res.status(400).json({ success: false, message: 'OTP expired' });
  }

  // Don't consume the OTP here — clients verify first, then call
  // reset-password with the same code, which re-validates and deletes it.
  // Consuming on verify made every subsequent reset fail with "Invalid OTP".
  res.json({ success: true, message: 'OTP verified' });
};

export const resetPassword = async (req, res) => {
  const { email, otp, newPassword } = req.body;
  const otpRecord = await OTP.findOne({ email, otp });
  if (!otpRecord) {
    return res.status(400).json({ success: false, message: 'Invalid OTP' });
  }

  if (otpRecord.expiresAt < new Date()) {
    await OTP.deleteOne({ _id: otpRecord._id });
    return res.status(400).json({ success: false, message: 'OTP expired' });
  }

  const user = await User.findOne({ email });
  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }

  user.password = newPassword;
  await user.save();

  await OTP.deleteOne({ _id: otpRecord._id });

  await revokeAllSessions(user._id, 'password_change');
  await logAudit({ shopId: user.shop, userId: user._id, action: 'auth.password_change', entityType: 'RefreshToken', req });

  res.json({ success: true, message: 'Password reset successfully' });
};
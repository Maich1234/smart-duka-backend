import User from '../../models/User.js';
import OTP from '../../models/OTP.js';
import { generateOTP } from '../../utils/generateOTP.js';
import { sendOTPEmail } from '../../utils/email.js';

export const changePassword = async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = await User.findById(req.user._id);
  const isMatch = await user.comparePassword(currentPassword);
  if (!isMatch) {
    return res.status(401).json({ success: false, message: 'Current password is incorrect' });
  }

  user.password = newPassword;
  await user.save();

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

  await sendOTPEmail(email, otp, user.name);

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

  res.json({ success: true, message: 'Password reset successfully' });
};
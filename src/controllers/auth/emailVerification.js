import User from '../../models/User.js';
import EmailVerificationToken from '../../models/EmailVerificationToken.js';
import { sendVerificationEmail } from '../../utils/emailVerification.js';

/**
 * Verify email using a 6‑digit code
 * Expects { email, code } in request body
 */
export const verifyEmail = async (req, res) => {
  const { email, code } = req.body;

  if (!email || !code) {
    return res.status(400).json({ success: false, message: 'Email and verification code are required' });
  }

  // Find user by email
  const user = await User.findOne({ email });
  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }

  // Find the verification record
  const record = await EmailVerificationToken.findOne({ userId: user._id, code });
  if (!record) {
    return res.status(400).json({ success: false, message: 'Invalid or expired verification code' });
  }

  if (record.expiresAt < new Date()) {
    await EmailVerificationToken.deleteOne({ _id: record._id });
    return res.status(400).json({ success: false, message: 'Code expired. Please request a new verification email.' });
  }

  if (user.isEmailVerified) {
    await EmailVerificationToken.deleteOne({ _id: record._id });
    return res.status(400).json({ success: false, message: 'Email already verified' });
  }

  // Verify the user
  user.isEmailVerified = true;
  await user.save();
  await EmailVerificationToken.deleteOne({ _id: record._id });

  res.json({ success: true, message: 'Email verified successfully. You can now log in.' });
};

/**
 * Resend verification email (authenticated user)
 */
export const resendVerificationEmail = async (req, res) => {
  const user = await User.findById(req.user._id);
  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }

  if (user.isEmailVerified) {
    return res.status(400).json({ success: false, message: 'Email already verified' });
  }

  // Delete any existing verification codes for this user
  await EmailVerificationToken.deleteMany({ userId: user._id });

  try {
    await sendVerificationEmail(user);
    res.json({ success: true, message: 'Verification code sent. Please check your email.' });
  } catch (error) {
    console.error('Resend verification error:', error);
    res.status(500).json({ success: false, message: 'Failed to send verification email. Please try again later.' });
  }
};
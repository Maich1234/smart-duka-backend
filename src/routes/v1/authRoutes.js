import express from 'express';
import rateLimit from 'express-rate-limit';
import {
  register,
  login,
  getProfile,
  updateProfile,
  changePassword,
  forgotPassword,
  verifyOTP,
  resetPassword,
  verifyEmail,
  resendVerificationEmail,
  resendVerificationEmailByEmail,
  registerDeviceToken,
  unregisterDeviceToken,
  refresh,
  logout,
  deleteAccount,
  previewAccountDeletion,
  cancelAccountDeletion,
} from '../../controllers/auth/index.js';
import { protect } from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import { createRateLimitStore } from '../../utils/rateLimitStore.js';
import {
  loginSchema,
  changePasswordSchema,
  registerSchema,
  forgotPasswordSchema,
  verifyOTPSchema,
  resetPasswordSchema,
  resendVerificationEmailSchema,
  verifyEmailSchema,
  deleteAccountSchema,
} from '../../validations/authValidation.js';

const router = express.Router();

// Unauthenticated endpoints are brute-forceable by IP — the OTP verify limit
// matters most (a 6-digit code survives ~1M guesses without one).
// createRateLimitStore returns an Upstash-backed shared store when configured
// (real enforcement across serverless instances) or undefined (per-instance
// memory store) otherwise.
const limiterDefaults = { standardHeaders: true, legacyHeaders: false };
const loginLimiter = rateLimit({
  ...limiterDefaults,
  windowMs: 15 * 60 * 1000,
  max: 20,
  store: createRateLimitStore('login'),
  message: { success: false, message: 'Too many login attempts. Please wait 15 minutes and try again.' },
});
const passwordResetLimiter = rateLimit({
  ...limiterDefaults,
  windowMs: 15 * 60 * 1000,
  max: 5,
  store: createRateLimitStore('pw-reset'),
  message: { success: false, message: 'Too many password reset requests. Please wait 15 minutes and try again.' },
});
const codeVerifyLimiter = rateLimit({
  ...limiterDefaults,
  windowMs: 10 * 60 * 1000,
  max: 10,
  store: createRateLimitStore('code-verify'),
  message: { success: false, message: 'Too many verification attempts. Please wait before trying again.' },
});
const registerLimiter = rateLimit({
  ...limiterDefaults,
  windowMs: 60 * 60 * 1000,
  max: 10,
  store: createRateLimitStore('register'),
  message: { success: false, message: 'Too many accounts created from this device. Please try again later.' },
});
// Generous: a healthy client refreshes ~once an hour; 30 per 15 min already
// signals a broken or malicious client.
const refreshLimiter = rateLimit({
  ...limiterDefaults,
  windowMs: 15 * 60 * 1000,
  max: 30,
  store: createRateLimitStore('refresh'),
  message: { success: false, message: 'Too many session refresh attempts. Please sign in again.' },
});

router.post('/register', registerLimiter, validate(registerSchema), register);
router.post('/login', loginLimiter, validate(loginSchema), login);
router.post('/forgot-password', passwordResetLimiter, validate(forgotPasswordSchema), forgotPassword);
router.post('/verify-otp', codeVerifyLimiter, validate(verifyOTPSchema), verifyOTP);
router.post('/reset-password', passwordResetLimiter, validate(resetPasswordSchema), resetPassword);
router.post('/verify-email', codeVerifyLimiter, validate(verifyEmailSchema), verifyEmail); // body { email, code }
router.post('/resend-verification-email', passwordResetLimiter, validate(resendVerificationEmailSchema), resendVerificationEmailByEmail);
router.post('/refresh', refreshLimiter, refresh);
router.post('/logout', logout);

router.get('/profile', protect, getProfile);
router.put('/profile', protect, updateProfile);
router.post('/change-password', protect, validate(changePasswordSchema), changePassword);
router.post('/resend-verification', protect, resendVerificationEmail);
router.post('/device-token', protect, registerDeviceToken);
router.delete('/device-token', protect, unregisterDeviceToken);

// Account deletion (Google Play requirement). Rate-limited like the other
// password-checking endpoints: the confirmation is password-gated, so an
// unlimited endpoint would be a credential oracle.
router.get('/me/deletion-preview', protect, previewAccountDeletion);
router.post('/me/restore', protect, cancelAccountDeletion);
router.delete('/me', protect, passwordResetLimiter, validate(deleteAccountSchema), deleteAccount);

export default router;
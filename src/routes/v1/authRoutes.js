import express from 'express';
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
} from '../../controllers/auth/index.js';
import { protect } from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import {
  loginSchema,
  changePasswordSchema,
  registerSchema,
  forgotPasswordSchema,
  verifyOTPSchema,
  resetPasswordSchema,
  resendVerificationEmailSchema,
  verifyEmailSchema,
} from '../../validations/authValidation.js';

const router = express.Router();

router.post('/register', validate(registerSchema), register);
router.post('/login', validate(loginSchema), login);
router.post('/forgot-password', validate(forgotPasswordSchema), forgotPassword);
router.post('/verify-otp', validate(verifyOTPSchema), verifyOTP);
router.post('/reset-password', validate(resetPasswordSchema), resetPassword);
router.post('/verify-email', validate(verifyEmailSchema), verifyEmail); // body { email, code }
router.post('/resend-verification-email', validate(resendVerificationEmailSchema), resendVerificationEmailByEmail);

router.get('/profile', protect, getProfile);
router.put('/profile', protect, updateProfile);
router.post('/change-password', protect, validate(changePasswordSchema), changePassword);
router.post('/resend-verification', protect, resendVerificationEmail);
router.post('/device-token', protect, registerDeviceToken);
router.delete('/device-token', protect, unregisterDeviceToken);

export default router;
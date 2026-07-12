import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { protect, ownerOnly } from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import { requestVerificationOTP, verifyVerificationOTP } from '../../controllers/otpController.js';
import { requestOTPSchema, verifyOTPSchema } from '../../validations/otpValidation.js';
import { createRateLimitStore } from '../../utils/rateLimitStore.js';

const router = express.Router();

// Strict rate limit on OTP requests to prevent SMS/email abuse
const otpRequestLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10-minute window
  max: 3,                    // max 3 OTP requests per user per 10 min
  keyGenerator: (req) => req.user?._id?.toString() ?? ipKeyGenerator(req),
  store: createRateLimitStore('otp-request'),
  message: { success: false, message: 'Too many verification requests. Please wait 10 minutes before trying again.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Strict rate limit on OTP verification attempts
const otpVerifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.user?._id?.toString() ?? ipKeyGenerator(req),
  store: createRateLimitStore('otp-verify'),
  message: { success: false, message: 'Too many verification attempts. Please wait before trying again.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/request', protect, ownerOnly, otpRequestLimiter, validate(requestOTPSchema), requestVerificationOTP);
router.post('/verify', protect, ownerOnly, otpVerifyLimiter, validate(verifyOTPSchema), verifyVerificationOTP);

export default router;

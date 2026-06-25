import express from 'express';
import { protect, ownerOnly, staffOrOwner } from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import { requireVerificationToken } from '../../services/otpService.js';
import {
  getPaymentStatus,
  getPaymentConfig,
  saveMpesaConfig,
  disconnectMpesa,
} from '../../controllers/paymentConfigController.js';
import { saveMpesaConfigSchema } from '../../validations/paymentConfigValidation.js';

const router = express.Router();

// Safe endpoint: only shows enabled/disabled — no credentials. All authenticated users.
router.get('/status', protect, staffOrOwner, getPaymentStatus);

// Sensitive endpoints: require identity verification via X-Verification-Token header
router.get('/', protect, ownerOnly, requireVerificationToken, getPaymentConfig);
router.put('/mpesa', protect, ownerOnly, requireVerificationToken, validate(saveMpesaConfigSchema), saveMpesaConfig);
router.delete('/mpesa', protect, ownerOnly, requireVerificationToken, disconnectMpesa);

export default router;

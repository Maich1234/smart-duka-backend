import express from 'express';
import { protect, ownerOnly } from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import {
  getPlans,
  previewPricing,
  validatePromo,
  getMySubscription,
  activateTrial,
  cancelSubscription,
  initiatePayment,
  getPaymentStatus,
  handleMpesaCallback,
} from '../../controllers/subscriptionController.js';
import {
  activateTrialSchema,
  initiatePaymentSchema,
  previewQuerySchema,
  validatePromoSchema,
} from '../../validations/subscriptionValidation.js';

const router = express.Router();

// Safaricom posts subscription STK results here — public, no JWT auth.
router.post('/mpesa/callback', handleMpesaCallback);

// Pricing catalog — any signed-in user (the activation screen shows it).
router.get('/plans', protect, getPlans);
router.get('/preview', protect, validate(previewQuerySchema, 'query'), previewPricing);
router.post('/promo/validate', protect, validate(validatePromoSchema), validatePromo);

// Subscription state — staff see it too (the lock applies shop-wide).
router.get('/me', protect, getMySubscription);

// Lifecycle + payments — owner only.
router.post('/trial', protect, ownerOnly, validate(activateTrialSchema), activateTrial);
router.post('/cancel', protect, ownerOnly, cancelSubscription);
router.post('/pay', protect, ownerOnly, validate(initiatePaymentSchema), initiatePayment);
router.get('/pay/:paymentId', protect, ownerOnly, getPaymentStatus);

export default router;

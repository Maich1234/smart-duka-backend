import express from 'express';
import { protect, ownerOnly } from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import { verifyMpesaCallbackToken } from '../../middlewares/verifyMpesaCallback.js';
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
  handlePaystackWebhook,
  recheckPayment,
  reconcileByMessage,
  resendRenewalLink,
} from '../../controllers/subscriptionController.js';
import {
  activateTrialSchema,
  initiatePaymentSchema,
  previewQuerySchema,
  validatePromoSchema,
  reconcileByMessageSchema,
} from '../../validations/subscriptionValidation.js';

const router = express.Router();

// Safaricom posts subscription STK results here — public, no JWT auth, but
// the final path segment is a shared secret (see verifyMpesaCallbackToken)
// since Daraja has no callback-signing mechanism.
router.post('/mpesa/callback/:token', verifyMpesaCallbackToken, handleMpesaCallback);
// Paystack posts charge results here — public, no JWT auth; verified via
// x-paystack-signature instead.
router.post('/paystack/webhook', handlePaystackWebhook);

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
router.post('/pay/:paymentId/recheck', protect, ownerOnly, recheckPayment);
router.post('/reconcile', protect, ownerOnly, validate(reconcileByMessageSchema), reconcileByMessage);
router.post('/resend-link', protect, ownerOnly, resendRenewalLink);

export default router;

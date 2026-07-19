import express from 'express';
import {
  createPurchase,
  getPurchases,
  getPurchaseById,
  updatePurchase,
  deletePurchase,
  approvePurchase,
  getPurchaseStatsHandler,
  getPurchaseAnalyticsHandler,
} from '../../controllers/purchaseController.js';
import { protect, staffOrOwner } from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import idempotency from '../../middlewares/idempotency.js';
import {
  createPurchaseSchema,
  updatePurchaseSchema,
  purchaseQuerySchema,
  purchaseAnalyticsQuerySchema,
} from '../../validations/purchaseValidation.js';

const router = express.Router();

router.use(protect);
// Role gate only checks authenticated staff-or-owner; each action enforces
// its own owner-or-permission (view/create/edit/delete_purchases) check —
// same convention as expenseRoutes.js/saleRoutes.js.
router.get('/stats', staffOrOwner, getPurchaseStatsHandler);
router.get('/analytics', staffOrOwner, validate(purchaseAnalyticsQuerySchema, 'query'), getPurchaseAnalyticsHandler);
router.get('/', staffOrOwner, validate(purchaseQuerySchema, 'query'), getPurchases);
router.get('/:id', staffOrOwner, getPurchaseById);
// idempotency: every mutating route can be retried by the mobile offline
// queue after a network failure — without dedupe a purchase that committed
// but timed out on the response would be recorded (and stock applied) twice.
router.post('/', staffOrOwner, idempotency, validate(createPurchaseSchema), createPurchase);
router.put('/:id', staffOrOwner, idempotency, validate(updatePurchaseSchema), updatePurchase);
router.delete('/:id', staffOrOwner, idempotency, deletePurchase);
router.post('/:id/approve', staffOrOwner, idempotency, approvePurchase);

export default router;

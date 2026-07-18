import express from 'express';
import { createSale, getSales, getSaleById, getMySales, getMyCommission, getSalesStats, voidSale, refundSale } from '../../controllers/saleController.js';
import { protect, staffOrOwner } from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import idempotency from '../../middlewares/idempotency.js';
import { createSaleSchema, saleQuerySchema } from '../../validations/saleValidation.js';

const router = express.Router();

router.use(protect);
// idempotency: the mobile offline queue retries this request after network
// failures — without dedupe a sale that committed but timed out on the
// response would be recorded twice (double revenue, double stock decrement).
router.post('/', staffOrOwner, idempotency, validate(createSaleSchema), createSale);
// Owner (or staff granted 'void_sale') corrects a mis-recorded sale.
// idempotency: void can be queued offline and retried — must not double-restore stock.
router.post('/:id/void', staffOrOwner, idempotency, voidSale);
// Owner (or staff granted 'refund_own_sales'/'refund_all_sales') returns the
// customer's money — via M-Pesa reversal for mpesa sales, over the counter
// otherwise. idempotency: a retried request must not fire a second reversal.
router.post('/:id/refund', staffOrOwner, idempotency, refundSale);
router.get('/stats', staffOrOwner, getSalesStats);
router.get('/', staffOrOwner, validate(saleQuerySchema, 'query'), getSales);
router.get('/me', staffOrOwner, getMySales);
router.get('/commissions/me', staffOrOwner, getMyCommission);
router.get('/:id', staffOrOwner, getSaleById);

export default router;
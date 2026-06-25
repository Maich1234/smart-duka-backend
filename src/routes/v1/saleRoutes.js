import express from 'express';
import { createSale, getSales, getSaleById, getMySales, getSalesStats } from '../../controllers/saleController.js';
import { protect, staffOrOwner } from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import { createSaleSchema, saleQuerySchema } from '../../validations/saleValidation.js';

const router = express.Router();

router.use(protect);
router.post('/', staffOrOwner, validate(createSaleSchema), createSale);
router.get('/stats', staffOrOwner, getSalesStats);
router.get('/', staffOrOwner, validate(saleQuerySchema, 'query'), getSales);
router.get('/me', staffOrOwner, getMySales);
router.get('/:id', staffOrOwner, getSaleById);

export default router;
import express from 'express';
import { protect, staffOrOwner } from '../../middlewares/auth.js';
import { requirePaidShop } from '../../middlewares/requirePaidShop.js';
import validate from '../../middlewares/validate.js';
import idempotency from '../../middlewares/idempotency.js';
import {
  createQuotation,
  getQuotations,
  getQuotationById,
  getQuotationPdf,
  sendQuotationEmail,
  updateQuotation,
  declineQuotation,
  deleteQuotation,
  convertQuotation,
} from '../../controllers/quotationController.js';
import { createQuotationSchema, updateQuotationSchema } from '../../validations/quotationValidation.js';

const router = express.Router();

router.use(protect);
router.use(staffOrOwner);

router.post('/', validate(createQuotationSchema), createQuotation);
router.get('/', getQuotations);
router.get('/:id', getQuotationById);
router.get('/:id/pdf', getQuotationPdf);
router.post('/:id/send-email', sendQuotationEmail);
router.patch('/:id', validate(updateQuotationSchema), updateQuotation);
router.patch('/:id/decline', declineQuotation);
router.delete('/:id', deleteQuotation);
// Unlike the rest of this router, convert moves stock/money (via
// createSaleTransaction, same as the till) — the one quotation route
// requirePaidShop needs to gate, same as saleRoutes.js's POST /.
router.post('/:id/convert', requirePaidShop, idempotency, convertQuotation);

export default router;

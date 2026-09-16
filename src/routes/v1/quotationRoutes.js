import express from 'express';
import { protect, staffOrOwner } from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import {
  createQuotation,
  getQuotations,
  getQuotationById,
  updateQuotation,
  declineQuotation,
  deleteQuotation,
} from '../../controllers/quotationController.js';
import { createQuotationSchema, updateQuotationSchema } from '../../validations/quotationValidation.js';

const router = express.Router();

router.use(protect);
router.use(staffOrOwner);

router.post('/', validate(createQuotationSchema), createQuotation);
router.get('/', getQuotations);
router.get('/:id', getQuotationById);
router.patch('/:id', validate(updateQuotationSchema), updateQuotation);
router.patch('/:id/decline', declineQuotation);
router.delete('/:id', deleteQuotation);

export default router;

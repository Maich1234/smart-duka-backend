import express from 'express';
import {
  getSuppliers,
  getSupplierById,
  createSupplier,
  updateSupplier,
  deleteSupplier,
} from '../../controllers/supplierController.js';
import { protect, staffOrOwner } from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import idempotency from '../../middlewares/idempotency.js';
import { createSupplierSchema, updateSupplierSchema, supplierQuerySchema } from '../../validations/supplierValidation.js';

const router = express.Router();

router.use(protect);
// Role gate only checks authenticated staff-or-owner; each action enforces
// its own owner-or-permission (view/create/edit/delete_purchases) check —
// same convention as expenseRoutes.js.
router.get('/', staffOrOwner, validate(supplierQuerySchema, 'query'), getSuppliers);
router.get('/:id', staffOrOwner, getSupplierById);
// idempotency: creates/edits can be queued offline and retried.
router.post('/', staffOrOwner, idempotency, validate(createSupplierSchema), createSupplier);
router.put('/:id', staffOrOwner, idempotency, validate(updateSupplierSchema), updateSupplier);
router.delete('/:id', staffOrOwner, deleteSupplier);

export default router;

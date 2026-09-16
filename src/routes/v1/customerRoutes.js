import express from 'express';
import {
  getCustomers,
  getCustomerById,
  createCustomer,
  updateCustomer,
  archiveCustomer,
} from '../../controllers/customerController.js';
import { protect, staffOrOwner } from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import idempotency from '../../middlewares/idempotency.js';
import {
  createCustomerSchema,
  updateCustomerSchema,
  customerQuerySchema,
} from '../../validations/customerValidation.js';

const router = express.Router();

router.use(protect);
// Role gate only checks authenticated staff-or-owner; each action enforces its
// own owner-or-permission check — same convention as supplierRoutes.js. Credit
// limits and the block flag are owner-only inside updateCustomer.
router.get('/', staffOrOwner, validate(customerQuerySchema, 'query'), getCustomers);
router.get('/:id', staffOrOwner, getCustomerById);
// idempotency: adding a customer at the counter can be retried on a flaky
// connection, and two records for one person would split their debt in half.
router.post('/', staffOrOwner, idempotency, validate(createCustomerSchema), createCustomer);
router.put('/:id', staffOrOwner, idempotency, validate(updateCustomerSchema), updateCustomer);
// Soft-delete. Refused while the customer still owes money.
router.delete('/:id', staffOrOwner, archiveCustomer);

export default router;

import express from 'express';
import {
  getExpenses,
  getExpenseSummary,
  createExpense,
  updateExpense,
  deleteExpense,
} from '../../controllers/expenseController.js';
import { protect, staffOrOwner } from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import idempotency from '../../middlewares/idempotency.js';
import { createExpenseSchema, updateExpenseSchema } from '../../validations/expenseValidation.js';

const router = express.Router();

router.use(protect);
router.get('/', staffOrOwner, getExpenses);
router.get('/summary', staffOrOwner, getExpenseSummary);
// Role gate only checks authenticated staff-or-owner; create/update/delete each
// enforce their own owner-or-permission (manage_expenses) check.
// idempotency: creates are retried by the mobile offline queue — dedupe them.
router.post('/', staffOrOwner, idempotency, validate(createExpenseSchema), createExpense);
router.put('/:id', staffOrOwner, idempotency, validate(updateExpenseSchema), updateExpense);
router.delete('/:id', staffOrOwner, deleteExpense);

export default router;

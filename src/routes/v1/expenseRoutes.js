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
import { createExpenseSchema, updateExpenseSchema } from '../../validations/expenseValidation.js';

const router = express.Router();

router.use(protect);
router.get('/', staffOrOwner, getExpenses);
router.get('/summary', staffOrOwner, getExpenseSummary);
// Role gate only checks authenticated staff-or-owner; create/update/delete each
// enforce their own owner-or-permission (manage_expenses) check.
router.post('/', staffOrOwner, validate(createExpenseSchema), createExpense);
router.put('/:id', staffOrOwner, validate(updateExpenseSchema), updateExpense);
router.delete('/:id', staffOrOwner, deleteExpense);

export default router;

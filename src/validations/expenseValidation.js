import Joi from 'joi';
import { EXPENSE_CATEGORY_VALUES } from '../models/Expense.js';
import { MONEY_OUT_METHODS } from '../constants/paymentMethods.js';

// Optional, not required: these schemas are .unknown(false), so a client that
// omits paymentMethod (an older build, or a payload queued offline before the
// field shipped) must still be accepted — the model defaults it to 'cash'.
export const createExpenseSchema = Joi.object({
  category: Joi.string().valid(...EXPENSE_CATEGORY_VALUES).required(),
  amount: Joi.number().positive().required(),
  description: Joi.string().optional().allow(''),
  paymentMethod: Joi.string().valid(...MONEY_OUT_METHODS).optional(),
  date: Joi.date().optional(),
}).unknown(false);

export const updateExpenseSchema = Joi.object({
  category: Joi.string().valid(...EXPENSE_CATEGORY_VALUES),
  amount: Joi.number().positive(),
  description: Joi.string().allow(''),
  paymentMethod: Joi.string().valid(...MONEY_OUT_METHODS),
  date: Joi.date(),
}).unknown(false);

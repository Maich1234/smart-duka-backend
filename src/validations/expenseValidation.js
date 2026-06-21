import Joi from 'joi';
import { EXPENSE_CATEGORY_VALUES } from '../models/Expense.js';

export const createExpenseSchema = Joi.object({
  category: Joi.string().valid(...EXPENSE_CATEGORY_VALUES).required(),
  amount: Joi.number().positive().required(),
  description: Joi.string().optional().allow(''),
  date: Joi.date().optional(),
}).unknown(false);

export const updateExpenseSchema = Joi.object({
  category: Joi.string().valid(...EXPENSE_CATEGORY_VALUES),
  amount: Joi.number().positive(),
  description: Joi.string().allow(''),
  date: Joi.date(),
}).unknown(false);

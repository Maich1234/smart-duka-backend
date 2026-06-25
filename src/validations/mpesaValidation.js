import Joi from 'joi';

export const initiateSTKPushSchema = Joi.object({
  phoneNumber: Joi.string().trim().pattern(/^(?:\+?254|0)?[17]\d{8}$/).required().messages({
    'string.pattern.base': 'Enter a valid Kenyan phone number (e.g. 0712345678 or +254712345678)',
  }),
  amount: Joi.number().positive().max(300000).required(),
  accountReference: Joi.string().trim().max(12).optional(),
}).unknown(false);

export const transactionQuerySchema = Joi.object({
  startDate: Joi.date().optional(),
  endDate: Joi.date().optional(),
  status: Joi.string().valid('pending', 'success', 'failed', 'cancelled', 'timeout').optional(),
  staffId: Joi.string().optional(),
  search: Joi.string().trim().optional(),
  page: Joi.number().min(1).default(1),
  limit: Joi.number().min(1).max(100).default(20),
}).unknown(false);

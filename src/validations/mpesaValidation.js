import Joi from 'joi';

// Only accept the fully-qualified E.164 Kenyan format (+2547... or +2541...).
// The frontend displays a locked "+254" prefix so users only enter the 9-digit suffix.
const KENYAN_PHONE_PATTERN = /^\+254[17]\d{8}$/;

export const initiateSTKPushSchema = Joi.object({
  phoneNumber: Joi.string().trim().pattern(KENYAN_PHONE_PATTERN).required().messages({
    'string.pattern.base': 'Phone number must be in +2547XXXXXXXX or +2541XXXXXXXX format',
  }),
  amount: Joi.number().positive().max(300000).required(),
  accountReference: Joi.string().trim().max(12).optional(),
}).unknown(false);

export const verifyReceiptSchema = Joi.object({
  receiptNumber: Joi.string().trim().min(6).max(20).required().messages({
    'string.empty': 'M-Pesa receipt number is required',
    'string.min': 'Receipt number must be at least 6 characters',
    'string.max': 'Receipt number must be at most 20 characters',
  }),
});

export const transactionQuerySchema = Joi.object({
  startDate: Joi.date().optional(),
  endDate: Joi.date().optional(),
  status: Joi.string().valid('pending', 'success', 'failed', 'cancelled', 'timeout').optional(),
  staffId: Joi.string().optional(),
  search: Joi.string().trim().optional(),
  page: Joi.number().min(1).default(1),
  limit: Joi.number().min(1).max(100).default(20),
}).unknown(false);

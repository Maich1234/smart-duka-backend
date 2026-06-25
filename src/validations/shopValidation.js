import Joi from 'joi';

export const updateShopConfigSchema = Joi.object({
  name: Joi.string().trim().min(1).optional(),
  address: Joi.string().allow('').optional(),
  phone: Joi.string().allow('').optional(),
  email: Joi.string().email({ tlds: { allow: false } }).lowercase().trim().allow('').optional(),
  taxRate: Joi.number().min(0).optional(),
  currency: Joi.string().trim().min(1).max(8).optional(),
  receiptThankYouNote: Joi.string().allow('').max(150).optional(),
  motto: Joi.string().allow('').max(200).optional(),
}).unknown(false);

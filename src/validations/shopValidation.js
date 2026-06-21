import Joi from 'joi';

export const updateShopConfigSchema = Joi.object({
  name: Joi.string().trim(),
  address: Joi.string().allow(''),
  phone: Joi.string().allow(''),
  email: Joi.string().email().lowercase().trim().allow(''),
  taxRate: Joi.number().min(0),
  currency: Joi.string().trim().max(8),
  receiptThankYouNote: Joi.string().allow('').max(150),
}).unknown(false);

import Joi from 'joi';

export const updateShopConfigSchema = Joi.object({
  name: Joi.string().trim(),
  address: Joi.string().allow(''),
  phone: Joi.string().allow(''),
  email: Joi.string().email().lowercase().trim().allow(''),
  taxRate: Joi.number().min(0),
}).unknown(false);

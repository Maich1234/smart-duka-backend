import Joi from 'joi';

export const saveMpesaConfigSchema = Joi.object({
  environment: Joi.string().valid('sandbox', 'production').required(),
  businessName: Joi.string().trim().min(2).max(100).required(),
  shortcode: Joi.string().trim().pattern(/^\d{5,7}$/).required().messages({
    'string.pattern.base': 'Shortcode must be 5–7 digits',
  }),
  // Optional on update: omit or send empty string to retain the existing encrypted value.
  consumerKey: Joi.string().trim().min(10).allow('').optional(),
  consumerSecret: Joi.string().trim().min(10).allow('').optional(),
  passkey: Joi.string().trim().min(10).allow('').optional(),
}).unknown(false);

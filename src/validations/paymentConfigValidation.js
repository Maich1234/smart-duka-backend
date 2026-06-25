import Joi from 'joi';

export const saveMpesaConfigSchema = Joi.object({
  environment: Joi.string().valid('sandbox', 'production').required(),
  businessName: Joi.string().trim().min(2).max(100).required(),
  shortcode: Joi.string().trim().pattern(/^\d{5,7}$/).required().messages({
    'string.pattern.base': 'Shortcode must be 5–7 digits',
  }),
  consumerKey: Joi.string().trim().min(10).required(),
  consumerSecret: Joi.string().trim().min(10).required(),
  passkey: Joi.string().trim().min(10).required(),
}).unknown(false);

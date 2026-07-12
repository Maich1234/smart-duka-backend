import Joi from 'joi';

// Same locked format as mpesaValidation: the app shows a fixed +254 prefix.
const KENYAN_PHONE_PATTERN = /^\+254[17]\d{8}$/;

const billingCycle = Joi.string().valid('monthly', 'yearly');
const planSlug = Joi.string().trim().lowercase().max(50);
const promoCode = Joi.string().trim().uppercase().max(30);

export const activateTrialSchema = Joi.object({
  planSlug: planSlug.optional(),
  billingCycle: billingCycle.default('monthly'),
}).unknown(false);

// No amount field on purpose — the server always computes the price.
export const initiatePaymentSchema = Joi.object({
  phoneNumber: Joi.string().trim().pattern(KENYAN_PHONE_PATTERN).required().messages({
    'string.pattern.base': 'Phone number must be in +2547XXXXXXXX or +2541XXXXXXXX format',
  }),
  billingCycle: billingCycle.default('monthly'),
  planSlug: planSlug.optional(),
  promoCode: promoCode.optional(),
  provider: Joi.string().valid('mpesa', 'card', 'bank').default('mpesa'),
}).unknown(false);

export const previewQuerySchema = Joi.object({
  staffCount: Joi.number().integer().min(1).max(1000).optional(),
  billingCycle: billingCycle.default('monthly'),
  planSlug: planSlug.optional(),
  promoCode: promoCode.optional(),
}).unknown(false);

export const validatePromoSchema = Joi.object({
  code: promoCode.required(),
}).unknown(false);

import Joi from 'joi';

// Same locked format as mpesaValidation: the app shows a fixed +254 prefix.
// Exported: also used by subscriptionController to validate phoneNumber at
// the point of actually charging via M-Pesa, since whether a phone number is
// required depends on the server-computed price (free promo/referral
// coverage needs none), not on the client-selected provider alone — Joi
// can't express that here.
export const KENYAN_PHONE_PATTERN = /^\+254[17]\d{8}$/;

const billingCycle = Joi.string().valid('monthly', 'quarterly', 'yearly');
const planSlug = Joi.string().trim().lowercase().max(50);
const promoCode = Joi.string().trim().uppercase().max(30);

export const activateTrialSchema = Joi.object({
  planSlug: planSlug.optional(),
  billingCycle: billingCycle.default('monthly'),
}).unknown(false);

// No amount field on purpose — the server always computes the price.
// phoneNumber is always optional at this layer: it's required for an actual
// M-Pesa charge, but not every request that names provider 'mpesa' ends up
// charging anything (a promo/referral credit can cover the invoice in full),
// so subscriptionController validates its presence itself once the real
// price is known.
export const initiatePaymentSchema = Joi.object({
  phoneNumber: Joi.string().trim().pattern(KENYAN_PHONE_PATTERN).optional().messages({
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

export const reconcileByMessageSchema = Joi.object({
  message: Joi.string().trim().min(1).max(500).required(),
}).unknown(false);

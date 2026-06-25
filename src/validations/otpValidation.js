import Joi from 'joi';

export const requestOTPSchema = Joi.object({
  method: Joi.string().valid('sms', 'email').required(),
}).unknown(false);

export const verifyOTPSchema = Joi.object({
  sessionId: Joi.string().required(),
  code: Joi.string().pattern(/^\d{6}$/).required().messages({
    'string.pattern.base': 'Verification code must be 6 digits',
  }),
}).unknown(false);

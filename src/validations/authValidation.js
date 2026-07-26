import Joi from 'joi';

// Optional — older clients that predate device-session tracking still log in
// fine, they just don't participate in single-device enforcement until they
// update.
const deviceSchema = Joi.object({
  deviceId: Joi.string().max(128).required(),
  deviceName: Joi.string().max(128).allow('', null).optional(),
  platform: Joi.string().valid('ios', 'android', 'web').optional(),
});

export const loginSchema = Joi.object({
  email: Joi.string().email().lowercase().trim().required(),
  password: Joi.string().required(),
  device: deviceSchema.optional(),
}).unknown(false);

export const changePasswordSchema = Joi.object({
  currentPassword: Joi.string().required(),
  newPassword: Joi.string().min(6).required(),
}).unknown(false);

export const registerSchema = Joi.object({
  name: Joi.string().required(),
  email: Joi.string().email().lowercase().trim().required(),
  password: Joi.string().min(6).required(),
  shopName: Joi.string().required(),
  address: Joi.string().optional(),
  phone: Joi.string().optional(),
  // Must be literally true. `.valid(true)` rather than a plain boolean so
  // sending false is a validation failure rather than a silently unticked box.
  acceptedTerms: Joi.boolean().valid(true).required().messages({
    'any.only': 'Please accept the Terms of Service and Privacy Policy to create an account.',
    'any.required': 'Please accept the Terms of Service and Privacy Policy to create an account.',
  }),
});

export const forgotPasswordSchema = Joi.object({
  email: Joi.string().email().lowercase().trim().required(),
}).unknown(false);

export const resendVerificationEmailSchema = Joi.object({
  email: Joi.string().email().lowercase().trim().required(),
}).unknown(false);

export const verifyOTPSchema = Joi.object({
  email: Joi.string().email().lowercase().trim().required(),
  otp: Joi.string().length(6).required(),
}).unknown(false);

export const resetPasswordSchema = Joi.object({
  email: Joi.string().email().lowercase().trim().required(),
  otp: Joi.string().length(6).required(),
  newPassword: Joi.string().min(6).required(),
}).unknown(false);

export const verifyEmailSchema = Joi.object({
  email: Joi.string().email().lowercase().trim().required(),
  code: Joi.string().length(6).required(),
}).unknown(false);

// Deletion is irreversible and, for an owner, cascades to the whole shop —
// so it takes both the account password and a typed confirmation.
export const deleteAccountSchema = Joi.object({
  password: Joi.string().required(),
  confirm: Joi.string().valid('DELETE').required(),
}).unknown(false);
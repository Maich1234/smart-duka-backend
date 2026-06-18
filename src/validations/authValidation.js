import Joi from 'joi';

export const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required(),
}).unknown(false);

export const changePasswordSchema = Joi.object({
  currentPassword: Joi.string().required(),
  newPassword: Joi.string().min(6).required(),
});

export const registerSchema = Joi.object({
  name: Joi.string().required(),
  email: Joi.string().email().required(),
  password: Joi.string().min(6).required(),
  shopName: Joi.string().required(),
  address: Joi.string().optional(),
  phone: Joi.string().optional(),
  role: Joi.string().valid('owner', 'staff').default('owner'),
}).unknown(false);

export const forgotPasswordSchema = Joi.object({
  email: Joi.string().email().required(),
}).unknown(false);

export const resendVerificationEmailSchema = Joi.object({
  email: Joi.string().email().required(),
}).unknown(false);

export const verifyOTPSchema = Joi.object({
  email: Joi.string().email().required(),
  otp: Joi.string().length(6).required(),
}).unknown(false);

export const resetPasswordSchema = Joi.object({
  email: Joi.string().email().required(),
  otp: Joi.string().length(6).required(),
  newPassword: Joi.string().min(6).required(),

}).unknown(false);
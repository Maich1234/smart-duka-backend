import Joi from 'joi';

export const createStaffSchema = Joi.object({
  name: Joi.string().required(),
  email: Joi.string().email().required(),
  password: Joi.string().min(6).required(),
  phone: Joi.string().optional(),
});

export const updateStaffSchema = Joi.object({
  name: Joi.string(),
  email: Joi.string().email(),
  phone: Joi.string(),
  isActive: Joi.boolean(),
});

export const resetPasswordSchema = Joi.object({
  newPassword: Joi.string().min(6).required(),
});
import Joi from 'joi';
import { ALL_PERMISSIONS } from '../constants/permissions.js';

const PERMISSION_VALUES = ALL_PERMISSIONS.map((p) => p.value);

export const createStaffSchema = Joi.object({
  name: Joi.string().required(),
  email: Joi.string().email().lowercase().trim().required(),
  password: Joi.string().min(6).required(),
  phone: Joi.string().optional().allow(''),
}).unknown(false);

export const updateStaffSchema = Joi.object({
  name: Joi.string(),
  email: Joi.string().email().lowercase().trim(),
  phone: Joi.string(),
  isActive: Joi.boolean(),
  permissions: Joi.array().items(Joi.string().valid(...PERMISSION_VALUES)),
}).unknown(false);

export const resetPasswordSchema = Joi.object({
  newPassword: Joi.string().min(6).required(),
}).unknown(false);

export const updateStaffPermissionsSchema = Joi.object({
  permissions: Joi.array().items(Joi.string().valid(...PERMISSION_VALUES)).required(),
}).unknown(false);
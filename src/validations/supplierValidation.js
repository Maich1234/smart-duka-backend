import Joi from 'joi';

export const createSupplierSchema = Joi.object({
  name: Joi.string().trim().min(1).required(),
  phone: Joi.string().trim().allow('').optional(),
  email: Joi.string().email({ tlds: { allow: false } }).lowercase().trim().allow('').optional(),
  location: Joi.string().trim().allow('').optional(),
  notes: Joi.string().trim().allow('').optional(),
}).unknown(false);

export const updateSupplierSchema = Joi.object({
  name: Joi.string().trim().min(1),
  phone: Joi.string().trim().allow(''),
  email: Joi.string().email({ tlds: { allow: false } }).lowercase().trim().allow(''),
  location: Joi.string().trim().allow(''),
  notes: Joi.string().trim().allow(''),
  isActive: Joi.boolean(),
}).unknown(false);

export const supplierQuerySchema = Joi.object({
  search: Joi.string().trim().max(60).allow(''),
  page: Joi.number().min(1).default(1),
  limit: Joi.number().min(1).max(100).default(20),
}).unknown(false);

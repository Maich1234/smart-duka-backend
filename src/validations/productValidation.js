import Joi from 'joi';

export const createProductSchema = Joi.object({
  name: Joi.string().required().trim(),
  description: Joi.string().optional().allow(''),
  category: Joi.string().required(),
  sellingPrice: Joi.number().positive().required(),
  costPrice: Joi.number().positive().required(),
  quantity: Joi.number().min(0).default(0),
  lowStockAlert: Joi.number().min(0).default(5),
});

export const updateProductSchema = Joi.object({
  name: Joi.string().trim(),
  description: Joi.string().allow(''),
  category: Joi.string(),
  sellingPrice: Joi.number().positive(),
  costPrice: Joi.number().positive(),
  quantity: Joi.number().min(0),
  lowStockAlert: Joi.number().min(0),
});

export const updateStockSchema = Joi.object({
  quantity: Joi.number().min(0).required(),
});
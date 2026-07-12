import Joi from 'joi';

export const startShiftSchema = Joi.object({
  openingFloat: Joi.number().min(0).max(10_000_000).default(0),
  openingNote: Joi.string().trim().allow('').max(300).optional(),
  device: Joi.object({
    platform: Joi.string().trim().max(40).optional(),
    name: Joi.string().trim().max(80).optional(),
    appVersion: Joi.string().trim().max(20).optional(),
  }).optional(),
}).unknown(false);

export const endShiftSchema = Joi.object({
  closingCount: Joi.number().min(0).max(10_000_000).optional(),
  closingNote: Joi.string().trim().allow('').max(300).optional(),
}).unknown(false);

export const shiftQuerySchema = Joi.object({
  staffId: Joi.string().optional(),
  status: Joi.string().valid('active', 'closed').optional(),
  startDate: Joi.date().optional(),
  endDate: Joi.date().optional(),
  page: Joi.number().min(1).default(1),
  limit: Joi.number().min(1).max(100).default(20),
}).unknown(false);

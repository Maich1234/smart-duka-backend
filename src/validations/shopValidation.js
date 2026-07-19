import Joi from 'joi';
import { VALID_COUNTRY_CODES, VALID_CURRENCY_CODES } from '../constants/presets.js';

export const updateShopConfigSchema = Joi.object({
  name: Joi.string().trim().min(1).optional(),
  address: Joi.string().allow('').optional(),
  county: Joi.string().allow('').optional(),
  subCounty: Joi.string().allow('').optional(),
  phone: Joi.string().allow('').optional(),
  email: Joi.string().email({ tlds: { allow: false } }).lowercase().trim().allow('').optional(),
  taxRate: Joi.number().min(0).optional(),
  country: Joi.string().valid(...VALID_COUNTRY_CODES).optional(),
  currency: Joi.string().valid(...VALID_CURRENCY_CODES).optional(),
  receiptThankYouNote: Joi.string().allow('').max(150).optional(),
  motto: Joi.string().allow('').max(200).optional(),
  logoUrl: Joi.string().allow('').trim().optional(),
  shiftManagementEnabled: Joi.boolean().optional(),
  showStaffCommission: Joi.boolean().optional(),
  purchasingEnabled: Joi.boolean().optional(),
  purchaseCostAllocationMethod: Joi.string().valid('quantity', 'value', 'none').optional(),
  aiEnabled: Joi.boolean().optional(),
}).unknown(false);

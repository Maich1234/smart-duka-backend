import Joi from 'joi';
import { VALID_COUNTRY_CODES, VALID_CURRENCY_CODES } from '../constants/presets.js';
import { METHOD_ICONS, METHOD_KEY_PATTERN } from '../constants/salePaymentMethods.js';

// The till's buttons, sent as a complete ordered list (the manager UI edits
// the whole set at once, so a partial merge would make removal impossible).
const paymentMethodsSchema = Joi.array()
  .items(
    Joi.object({
      key: Joi.string().trim().lowercase().pattern(METHOD_KEY_PATTERN).required()
        .messages({ 'string.pattern.base': 'Payment method keys may only use lowercase letters, numbers and underscores.' }),
      label: Joi.string().trim().min(1).max(24).required(),
      icon: Joi.string().valid(...METHOD_ICONS).default('wallet'),
      enabled: Joi.boolean().default(true),
      order: Joi.number().integer().min(0).optional(),
    })
  )
  .min(1)
  .max(12)
  .custom((methods, helpers) => {
    const keys = methods.map((m) => m.key);
    if (new Set(keys).size !== keys.length) {
      return helpers.message('Each payment method must have a unique key.');
    }
    if (!methods.some((m) => m.enabled !== false)) {
      return helpers.message('Keep at least one payment method switched on — the till needs something to sell with.');
    }
    return methods;
  });

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
  paymentMethods: paymentMethodsSchema.optional(),
}).unknown(false);

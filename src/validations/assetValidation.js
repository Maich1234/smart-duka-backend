import Joi from 'joi';
import { ASSET_CATEGORY_VALUES, ASSET_STATUS_VALUES } from '../models/Asset.js';

// `.allow(null)` on currentValue is load-bearing: null is how the owner says
// "I haven't estimated this", which is different from 0 ("it's worth nothing
// now"). Stripping it to undefined would make clearing an estimate impossible.
const currentValue = Joi.number().min(0).allow(null);

// Scheme-restricted: Joi's bare `.uri()` accepts `javascript:` and `data:`
// too, and this value is stored and handed back to clients to render. Nothing
// renders it yet, which is exactly when it is cheap to close.
const imageUrl = Joi.string().trim().uri({ scheme: ['http', 'https'] }).allow('');

export const createAssetSchema = Joi.object({
  name: Joi.string().trim().max(120).required(),
  category: Joi.string().valid(...ASSET_CATEGORY_VALUES).optional(),
  acquisitionValue: Joi.number().min(0).required(),
  currentValue: currentValue.optional(),
  acquisitionDate: Joi.date().optional(),
  quantity: Joi.number().integer().min(1).optional(),
  serialNumber: Joi.string().trim().max(60).allow('').optional(),
  notes: Joi.string().trim().max(500).allow('').optional(),
  imageUrl: imageUrl.optional(),
  status: Joi.string().valid(...ASSET_STATUS_VALUES).optional(),
}).unknown(false);

export const updateAssetSchema = Joi.object({
  name: Joi.string().trim().max(120),
  category: Joi.string().valid(...ASSET_CATEGORY_VALUES),
  acquisitionValue: Joi.number().min(0),
  currentValue,
  acquisitionDate: Joi.date(),
  quantity: Joi.number().integer().min(1),
  serialNumber: Joi.string().trim().max(60).allow(''),
  notes: Joi.string().trim().max(500).allow(''),
  imageUrl,
  status: Joi.string().valid(...ASSET_STATUS_VALUES),
  // Archive/restore rides on the normal update rather than its own route:
  // there is no DELETE for assets, and a boolean the form already owns is a
  // smaller surface than a second endpoint that does one field.
  archived: Joi.boolean(),
}).unknown(false).min(1);

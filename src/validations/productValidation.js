import Joi from 'joi';

const PRODUCT_TYPES = ['standard', 'variable', 'weighted', 'refillable', 'service', 'bundle', 'configurable'];
const UNITS_OF_MEASURE = ['unit', 'kg', 'g', 'l', 'ml'];

const bundleItemSchema = Joi.object({
  product: Joi.string().required(),
  quantity: Joi.number().positive().required(),
});

const variantSchema = Joi.object({
  name: Joi.string().required().trim(),
  sellingPrice: Joi.number().min(0).required(),
  costPrice: Joi.number().min(0).required(),
  quantity: Joi.number().min(0).default(0),
  sku: Joi.string().trim().allow(''),
  lowStockAlert: Joi.number().min(0).default(5),
});

const promotionSchema = Joi.object({
  label: Joi.string().trim().allow(''),
  buyQty: Joi.number().integer().min(1).required(),
  freeQty: Joi.number().integer().min(1).required(),
  isActive: Joi.boolean().default(true),
});

export const createProductSchema = Joi.object({
  name: Joi.string().required().trim(),
  description: Joi.string().optional().allow(''),
  category: Joi.string().required(),
  productType: Joi.string().valid(...PRODUCT_TYPES).default('standard'),
  sellingPrice: Joi.number().positive().required(),
  costPrice: Joi.number().positive().required(),
  quantity: Joi.number().min(0).default(0),
  lowStockAlert: Joi.number().min(0).default(5),
  trackInventory: Joi.boolean().default(true),
  unitOfMeasure: Joi.string().valid(...UNITS_OF_MEASURE).default('unit'),
  minPrice: Joi.number().min(0)
    .when('productType', { is: 'variable', then: Joi.optional(), otherwise: Joi.forbidden() }),
  maxPrice: Joi.number().min(Joi.ref('minPrice'))
    .when('productType', { is: 'variable', then: Joi.optional(), otherwise: Joi.forbidden() }),
  allowPriceOverride: Joi.boolean()
    .when('productType', { is: 'service', then: Joi.optional().default(false), otherwise: Joi.forbidden() }),
  bundleItems: Joi.array().items(bundleItemSchema).min(1)
    .when('productType', { is: 'bundle', then: Joi.required(), otherwise: Joi.forbidden() }),
  variants: Joi.array().items(variantSchema).min(1)
    .when('productType', { is: 'configurable', then: Joi.required(), otherwise: Joi.forbidden() }),
  promotions: Joi.array().items(promotionSchema)
    .when('productType', { is: Joi.valid('bundle', 'configurable'), then: Joi.forbidden(), otherwise: Joi.optional() }),
}).unknown(false);

export const updateProductSchema = Joi.object({
  name: Joi.string().trim(),
  description: Joi.string().allow(''),
  category: Joi.string(),
  productType: Joi.string().valid(...PRODUCT_TYPES),
  sellingPrice: Joi.number().positive(),
  costPrice: Joi.number().positive(),
  quantity: Joi.number().min(0),
  lowStockAlert: Joi.number().min(0),
  trackInventory: Joi.boolean(),
  unitOfMeasure: Joi.string().valid(...UNITS_OF_MEASURE),
  minPrice: Joi.number().min(0),
  maxPrice: Joi.number().min(0),
  allowPriceOverride: Joi.boolean(),
  bundleItems: Joi.array().items(bundleItemSchema).min(1),
  variants: Joi.array().items(variantSchema).min(1),
  promotions: Joi.array().items(promotionSchema),
}).unknown(false);

export const updateStockSchema = Joi.object({
  quantity: Joi.number().min(0).required(),
}).unknown(false);

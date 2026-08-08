import Joi from 'joi';
import { VALID_UNITS } from '../constants/presets.js';

const PRODUCT_TYPES = ['standard', 'variable', 'weighted', 'refillable', 'service', 'bundle', 'configurable'];

const bundleItemSchema = Joi.object({
  product: Joi.string().required(),
  quantity: Joi.number().positive().required(),
});

// Shared by the product-level config and the per-variant override. `basePrice`
// is only meaningful when enabled, so it's required exactly then — an enabled
// config with no floor would silently pay out 100% of the line as commission.
const commissionSchema = Joi.object({
  enabled: Joi.boolean().default(false),
  basePrice: Joi.number().min(0)
    .when('enabled', { is: true, then: Joi.required(), otherwise: Joi.optional() }),
  employeeSharePercent: Joi.number().min(0).max(100).default(100),
});

const variantSchema = Joi.object({
  /**
   * Identity of an existing variant, echoed back by the client.
   *
   * Required for two reasons. Sales reference a variant by id, so replacing
   * the subdocument array without it makes Mongoose mint fresh ids and orphans
   * every historical `variantId`. And a staff update is merged against the
   * stored row by this id — see updateProduct in productController.js.
   *
   * Note `validate` runs with stripUnknown, so an unlisted key is dropped in
   * silence rather than rejected: it has to be declared here to survive.
   */
  _id: Joi.string().optional(),
  name: Joi.string().required().trim(),
  sellingPrice: Joi.number().min(0).required(),
  // Optional at this layer because a staff client omits it for variants it was
  // never shown; the controller restores the stored value before this reaches
  // Mongoose, where the field is still required.
  costPrice: Joi.number().min(0),
  quantity: Joi.number().min(0).default(0),
  sku: Joi.string().trim().allow(''),
  barcode: Joi.string().trim().allow(''),
  lowStockAlert: Joi.number().min(0).default(5),
  commission: commissionSchema.optional(),
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
  sku: Joi.string().trim().allow(''),
  barcode: Joi.string().trim().allow(''),
  productType: Joi.string().valid(...PRODUCT_TYPES).default('standard'),
  sellingPrice: Joi.number().positive().required(),
  costPrice: Joi.number().positive().required(),
  quantity: Joi.number().min(0).default(0),
  lowStockAlert: Joi.number().min(0).default(5),
  trackInventory: Joi.boolean().default(true),
  unitOfMeasure: Joi.string().valid(...VALID_UNITS).default('unit'),
  minPrice: Joi.number().min(0)
    .when('productType', { is: 'variable', then: Joi.optional(), otherwise: Joi.forbidden() }),
  maxPrice: Joi.number().min(Joi.ref('minPrice'))
    .when('productType', { is: 'variable', then: Joi.optional(), otherwise: Joi.forbidden() }),
  allowPriceOverride: Joi.boolean()
    .when('productType', { is: 'service', then: Joi.optional().default(false), otherwise: Joi.forbidden() }),
  // Allowed on every product type — commission is not a variant-only concept.
  commission: commissionSchema.optional(),
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
  sku: Joi.string().trim().allow(''),
  barcode: Joi.string().trim().allow(''),
  productType: Joi.string().valid(...PRODUCT_TYPES),
  sellingPrice: Joi.number().positive(),
  costPrice: Joi.number().positive(),
  quantity: Joi.number().min(0),
  lowStockAlert: Joi.number().min(0),
  trackInventory: Joi.boolean(),
  unitOfMeasure: Joi.string().valid(...VALID_UNITS),
  minPrice: Joi.number().min(0),
  maxPrice: Joi.number().min(0),
  allowPriceOverride: Joi.boolean(),
  commission: commissionSchema,
  bundleItems: Joi.array().items(bundleItemSchema).min(1),
  variants: Joi.array().items(variantSchema).min(1),
  promotions: Joi.array().items(promotionSchema),
}).unknown(false);

export const updateStockSchema = Joi.object({
  quantity: Joi.number().min(0).required(),
}).unknown(false);

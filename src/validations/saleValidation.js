import Joi from 'joi';

export const createSaleSchema = Joi.object({
  items: Joi.array()
    .items(
      Joi.object({
        productId: Joi.string().required(),
        // Whole-number enforcement for non-weighted product types happens in
        // pricingEngine.js, where the product's productType is known.
        quantity: Joi.number().positive().required(),
        unitPrice: Joi.number().positive().optional(), // override for 'variable'/'service' types
        variantId: Joi.string().optional(), // required for 'configurable' types
      })
    )
    .min(1)
    .required(),
  paymentMethod: Joi.string().valid('cash', 'mpesa').required(),
}).unknown(false);

export const saleQuerySchema = Joi.object({
  startDate: Joi.date(),
  endDate: Joi.date(),
  staffId: Joi.string(),
  paymentMethod: Joi.string().valid('cash', 'mpesa'),
  page: Joi.number().min(1).default(1),
  limit: Joi.number().min(1).max(100).default(20),
}).unknown(false);
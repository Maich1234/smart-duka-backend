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
  paymentMethod: Joi.string().valid('cash', 'mpesa', 'card').required(),
  // For M-Pesa sales: links the confirmed STK Push transaction to this sale
  mpesaTransactionId: Joi.string().optional(),
  // Offline fallback: receipt code staff typed from the customer's
  // confirmation SMS. validate() runs with stripUnknown, so this MUST be
  // declared here or it silently never reaches the controller.
  mpesaReceiptNumber: Joi.string().trim().uppercase().min(6).max(20).optional(),
}).unknown(false);

export const saleQuerySchema = Joi.object({
  startDate: Joi.date(),
  endDate: Joi.date(),
  staffId: Joi.string(),
  paymentMethod: Joi.string().valid('cash', 'mpesa', 'card'),
  // Free-text search across invoice number and cashier name
  search: Joi.string().trim().max(60).allow(''),
  page: Joi.number().min(1).default(1),
  limit: Joi.number().min(1).max(100).default(20),
}).unknown(false);
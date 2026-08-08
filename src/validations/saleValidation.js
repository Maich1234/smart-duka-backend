import Joi from 'joi';
import { METHOD_KEY_PATTERN } from '../constants/salePaymentMethods.js';

// Shape only — whether the shop actually offers this method is checked in the
// controller, which is the only layer that can load the shop's config.
const methodKey = Joi.string().trim().lowercase().pattern(METHOD_KEY_PATTERN);

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
  paymentMethod: methodKey.required(),
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
  status: Joi.string().valid('completed', 'voided', 'refund_pending', 'refunded'),
  paymentMethod: methodKey,
  // Free-text search across invoice number and cashier name
  search: Joi.string().trim().max(60).allow(''),
  page: Joi.number().min(1).default(1),
  limit: Joi.number().min(1).max(100).default(20),
}).unknown(false);
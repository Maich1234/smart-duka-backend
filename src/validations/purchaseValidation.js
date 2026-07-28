import Joi from 'joi';
import { PURCHASE_COST_CATEGORY_VALUES } from '../models/Purchase.js';
import { MONEY_OUT_METHODS } from '../constants/paymentMethods.js';

const purchaseItemInputSchema = Joi.object({
  productId: Joi.string().required(),
  quantity: Joi.number().positive().required(),
  unitCost: Joi.number().min(0).required(),
  // Client computes and sends whichever value it derived (see the New
  // Purchase screen's quantity/unitCost/totalCost auto-calc) — the server
  // re-derives it anyway rather than trusting the client's math.
  variantId: Joi.string().optional(), // required for 'configurable' products
});

const purchaseCostInputSchema = Joi.object({
  category: Joi.string().valid(...PURCHASE_COST_CATEGORY_VALUES).required(),
  description: Joi.string().trim().allow('').optional(),
  amount: Joi.number().min(0).required(),
  notes: Joi.string().trim().allow('').optional(),
});

export const createPurchaseSchema = Joi.object({
  supplierId: Joi.string().optional(), // omitted for walk-in / no-supplier purchases
  supplierName: Joi.string().trim().allow('').max(120).optional(), // manual walk-in label
  items: Joi.array().items(purchaseItemInputSchema).min(1).required(),
  additionalCosts: Joi.array().items(purchaseCostInputSchema).default([]),
  // Optional, not required — these schemas are .unknown(false), so an older
  // client or a payload queued offline before this field shipped must still be
  // accepted. The model defaults it to 'cash'.
  paymentMethod: Joi.string().valid(...MONEY_OUT_METHODS).optional(),
  purchaseDate: Joi.date().optional(),
}).unknown(false);

export const updatePurchaseSchema = Joi.object({
  supplierId: Joi.string().allow(null),
  supplierName: Joi.string().trim().allow('').max(120),
  items: Joi.array().items(purchaseItemInputSchema).min(1),
  additionalCosts: Joi.array().items(purchaseCostInputSchema),
  paymentMethod: Joi.string().valid(...MONEY_OUT_METHODS),
  purchaseDate: Joi.date(),
}).unknown(false);

export const purchaseQuerySchema = Joi.object({
  startDate: Joi.date(),
  endDate: Joi.date(),
  staffId: Joi.string(),
  supplierId: Joi.string(),
  productId: Joi.string(),
  status: Joi.string().valid('completed', 'pending_approval', 'cancelled'),
  minCost: Joi.number().min(0),
  maxCost: Joi.number().min(0),
  // Free-text search across supplier name and product names in this purchase
  search: Joi.string().trim().max(60).allow(''),
  sort: Joi.string().valid('newest', 'oldest', 'highest_cost', 'lowest_cost').default('newest'),
  page: Joi.number().min(1).default(1),
  limit: Joi.number().min(1).max(100).default(20),
}).unknown(false);

export const approvePurchaseSchema = Joi.object({}).unknown(false);

export const purchaseAnalyticsQuerySchema = Joi.object({
  period: Joi.string().valid('daily', 'weekly', 'monthly').default('monthly'),
}).unknown(false);

import Joi from 'joi';
import { MAX_CREDIT_LIMIT } from '../constants/credit.js';

// Mongo ObjectId shape. Rejecting a malformed id here keeps CastError noise
// out of the error handler and stops a crafted value reaching a query.
export const objectId = Joi.string().hex().length(24);

// A shilling amount. `precision(2)` rounds rather than rejects (Joi's default
// convert behaviour), which is what a client sending 1999.999 deserves.
export const creditLimit = Joi.number().min(0).max(MAX_CREDIT_LIMIT).precision(2);

export const createCustomerSchema = Joi.object({
  name: Joi.string().trim().min(1).max(120).required(),
  phone: Joi.string().trim().max(20).allow('').optional(),
  email: Joi.string().email({ tlds: { allow: false } }).lowercase().trim().allow('').optional(),
  notes: Joi.string().trim().max(500).allow('').optional(),
  // Owner-only in the controller — declared here so a legitimate owner request
  // survives stripUnknown, not because anyone may send it.
  creditLimit: creditLimit.allow(null).optional(),
}).unknown(false);

export const updateCustomerSchema = Joi.object({
  name: Joi.string().trim().min(1).max(120),
  phone: Joi.string().trim().max(20).allow(''),
  email: Joi.string().email({ tlds: { allow: false } }).lowercase().trim().allow(''),
  notes: Joi.string().trim().max(500).allow(''),
  // null = fall back to the shop default. Owner-only, enforced in the controller.
  creditLimit: creditLimit.allow(null),
  creditBlocked: Joi.boolean(),
  creditBlockedReason: Joi.string().trim().max(200).allow(''),
}).unknown(false);

export const customerQuerySchema = Joi.object({
  search: Joi.string().trim().max(60).allow(''),
  // Mirrors the Credit section's filter chips. 'outstanding' is anything still
  // owed (current or overdue); 'paid' is a cleared account, which is not the
  // same as one that never borrowed.
  filter: Joi.string().valid('all', 'outstanding', 'overdue', 'paid').default('all'),
  // Archived customers are hidden by default; the owner can ask for them.
  includeArchived: Joi.boolean().default(false),
  sort: Joi.string().valid('name', 'outstanding', 'recent').default('name'),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
}).unknown(false);

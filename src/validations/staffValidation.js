import Joi from 'joi';
import { ALL_PERMISSIONS } from '../constants/permissions.js';

const PERMISSION_VALUES = ALL_PERMISSIONS.map((p) => p.value);

export const createStaffSchema = Joi.object({
  name: Joi.string().required(),
  email: Joi.string().email().lowercase().trim().required(),
  password: Joi.string().min(6).required(),
  phone: Joi.string().optional().allow(''),
  // Optional so the client can create staff + permissions in one atomic
  // request (required for offline queueing — a follow-up permissions call
  // can't reference a server id that doesn't exist yet). Omitted → defaults.
  permissions: Joi.array().items(Joi.string().valid(...PERMISSION_VALUES)),
  commissionEligible: Joi.boolean(),
}).unknown(false);

// POST /staff/seat-payment — same staff draft as createStaffSchema, plus the
// M-Pesa number to charge for the seat.
export const initiateSeatPaymentSchema = Joi.object({
  name: Joi.string().required(),
  email: Joi.string().email().lowercase().trim().required(),
  password: Joi.string().min(6).required(),
  phone: Joi.string().optional().allow(''),
  permissions: Joi.array().items(Joi.string().valid(...PERMISSION_VALUES)),
  phoneNumber: Joi.string().required(),
}).unknown(false);

export const seatPaymentReconcileSchema = Joi.object({
  message: Joi.string().required(),
}).unknown(false);

export const updateStaffSchema = Joi.object({
  name: Joi.string(),
  email: Joi.string().email().lowercase().trim(),
  phone: Joi.string().allow(''),
  isActive: Joi.boolean(),
  permissions: Joi.array().items(Joi.string().valid(...PERMISSION_VALUES)),
  commissionEligible: Joi.boolean(),
}).unknown(false);

export const resetPasswordSchema = Joi.object({
  newPassword: Joi.string().min(6).required(),
}).unknown(false);

export const updateStaffPermissionsSchema = Joi.object({
  permissions: Joi.array().items(Joi.string().valid(...PERMISSION_VALUES)).required(),
}).unknown(false);
// POST /staff/:id/deletion-request/decline — the reason is optional but is
// relayed verbatim to the staff member, so it stays short.
export const declineStaffDeletionRequestSchema = Joi.object({
  reason: Joi.string().max(300).allow('').optional(),
}).unknown(false);

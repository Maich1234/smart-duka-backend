import Joi from 'joi';
import { ADMIN_PERMISSION_VALUES } from '../constants/adminPermissions.js';

export const adminLoginSchema = Joi.object({
  email: Joi.string().email().lowercase().trim().required(),
  password: Joi.string().required(),
}).unknown(false);

export const createPlanSchema = Joi.object({
  slug: Joi.string().lowercase().trim().required(),
  name: Joi.string().trim().required(),
  tagline: Joi.string().trim().allow('').default(''),
  description: Joi.string().trim().allow('').default(''),
  billingType: Joi.string().valid('per_staff', 'flat').required(),
  monthlyPrice: Joi.number().min(0).required(),
  yearlyDiscountPercent: Joi.number().min(0).max(100).default(20),
  yearlyPrice: Joi.number().min(0).allow(null).default(null),
  maxStaff: Joi.number().min(1).required(),
  extraStaffPrice: Joi.number().min(0).default(0),
  trialDays: Joi.number().min(0).default(30),
  currency: Joi.string().uppercase().trim().default('KES'),
  highlights: Joi.array().items(Joi.string()).default([]),
  features: Joi.array().items(Joi.string()).default([]),
  badge: Joi.string().trim().allow('').default(''),
  priceComparison: Joi.string().trim().allow('').default(''),
  active: Joi.boolean().default(true),
  displayOrder: Joi.number().default(0),
  chatLimits: Joi.object({
    maxConversations: Joi.number().integer().min(0).allow(null).default(null),
    maxNewConversationsPerDay: Joi.number().integer().min(0).allow(null).default(null),
    maxMessagesPerDay: Joi.number().integer().min(0).allow(null).default(null),
  }).default({ maxConversations: null, maxNewConversationsPerDay: null, maxMessagesPerDay: null }),
}).unknown(false);

// Deliberately NOT derived from createPlanSchema via .fork() — that schema is
// full of .default(...) values, and Joi applies defaults to every *absent*
// key, not just missing required ones. A PATCH validated against it would
// silently overwrite every omitted field with its default. Every field here
// is optional with no default, so `value` only ever contains what the admin
// actually sent, and the controller only updates those keys.
export const updatePlanSchema = Joi.object({
  slug: Joi.string().lowercase().trim(),
  name: Joi.string().trim(),
  tagline: Joi.string().trim().allow(''),
  description: Joi.string().trim().allow(''),
  billingType: Joi.string().valid('per_staff', 'flat'),
  monthlyPrice: Joi.number().min(0),
  yearlyDiscountPercent: Joi.number().min(0).max(100),
  yearlyPrice: Joi.number().min(0).allow(null),
  maxStaff: Joi.number().min(1),
  extraStaffPrice: Joi.number().min(0),
  trialDays: Joi.number().min(0),
  currency: Joi.string().uppercase().trim(),
  highlights: Joi.array().items(Joi.string()),
  features: Joi.array().items(Joi.string()),
  badge: Joi.string().trim().allow(''),
  priceComparison: Joi.string().trim().allow(''),
  active: Joi.boolean(),
  displayOrder: Joi.number(),
  chatLimits: Joi.object({
    maxConversations: Joi.number().integer().min(0).allow(null),
    maxNewConversationsPerDay: Joi.number().integer().min(0).allow(null),
    maxMessagesPerDay: Joi.number().integer().min(0).allow(null),
  }),
}).unknown(false).min(1);

export const createPromotionSchema = Joi.object({
  code: Joi.string().uppercase().trim().required(),
  title: Joi.string().trim().required(),
  description: Joi.string().trim().allow('').default(''),
  discountType: Joi.string().valid('percentage', 'fixed').required(),
  discountValue: Joi.number().min(0).required(),
  startsAt: Joi.date().allow(null).default(null),
  endsAt: Joi.date().allow(null).default(null),
  maxRedemptions: Joi.number().min(1).allow(null).default(null),
  active: Joi.boolean().default(true),
}).unknown(false);

// Same reasoning as updatePlanSchema — no defaults, everything optional.
export const updatePromotionSchema = Joi.object({
  code: Joi.string().uppercase().trim(),
  title: Joi.string().trim(),
  description: Joi.string().trim().allow(''),
  discountType: Joi.string().valid('percentage', 'fixed'),
  discountValue: Joi.number().min(0),
  startsAt: Joi.date().allow(null),
  endsAt: Joi.date().allow(null),
  maxRedemptions: Joi.number().min(1).allow(null),
  active: Joi.boolean(),
}).unknown(false).min(1);

const segmentSchema = Joi.object({
  type: Joi.string().valid('all', 'state', 'plan', 'location').required(),
  states: Joi.array().items(Joi.string().valid('none', 'trialing', 'active', 'grace', 'locked'))
    .when('type', { is: 'state', then: Joi.array().min(1).required(), otherwise: Joi.array().max(0) }),
  planSlugs: Joi.array().items(Joi.string())
    .when('type', { is: 'plan', then: Joi.array().min(1).required(), otherwise: Joi.array().max(0) }),
  country: Joi.string().uppercase()
    .when('type', { is: 'location', then: Joi.string().required(), otherwise: Joi.string().allow(null).default(null) }),
  counties: Joi.array().items(Joi.string())
    .when('type', { is: 'location', then: Joi.array().min(1).required(), otherwise: Joi.array().max(0) }),
  roles: Joi.array().items(Joi.string().valid('owner', 'staff')).min(1).default(['owner']),
}).unknown(false);

export const createPushCampaignSchema = Joi.object({
  title: Joi.string().trim().required(),
  body: Joi.string().trim().required(),
  data: Joi.object().pattern(Joi.string(), Joi.string()).default(undefined),
  segment: segmentSchema.required(),
  scheduledAt: Joi.date().allow(null).default(null),
}).unknown(false);

export const createAdminUserSchema = Joi.object({
  name: Joi.string().trim().required(),
  email: Joi.string().email().lowercase().trim().required(),
  password: Joi.string().min(6).required(),
  role: Joi.string().valid('super_admin', 'admin').default('admin'),
  permissions: Joi.array().items(Joi.string().valid(...ADMIN_PERMISSION_VALUES)).default([]),
}).unknown(false);

// No defaults — same reasoning as updatePlanSchema/updatePromotionSchema: a
// PATCH only ever contains what the caller actually sent.
export const updateAdminUserSchema = Joi.object({
  name: Joi.string().trim(),
  email: Joi.string().email().lowercase().trim(),
  password: Joi.string().min(6),
  role: Joi.string().valid('super_admin', 'admin'),
  permissions: Joi.array().items(Joi.string().valid(...ADMIN_PERMISSION_VALUES)),
  active: Joi.boolean(),
}).unknown(false).min(1);

// PlatformConfig is always a partial update (secrets are only sent when
// actively being changed) — no defaults here either, for the same reason.
export const updatePlatformConfigSchema = Joi.object({
  enabled: Joi.boolean(),
  environment: Joi.string().valid('sandbox', 'production'),
  businessName: Joi.string().trim().allow(''),
  shortcode: Joi.string().trim().allow(''),
  consumerKey: Joi.string().trim().allow(''),
  consumerSecret: Joi.string().trim().allow(''),
  passkey: Joi.string().trim().allow(''),
  gracePeriodDays: Joi.number().min(0),
  staffGraceExtraDays: Joi.number().min(0),
  reminderDaysBefore: Joi.array().items(Joi.number().min(0)),
}).unknown(false).min(1);

// Support-granted breathing room for one shop. Capped at 30 days so a
// mis-typed value can't hand out a free year.
export const grantGraceExtensionSchema = Joi.object({
  days: Joi.number().integer().min(0).max(30).required(),
  reason: Joi.string().max(200).allow('').optional(),
}).unknown(false);

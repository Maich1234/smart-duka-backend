import express from 'express';
import rateLimit from 'express-rate-limit';
import { login, getProfile } from '../../controllers/adminAuthController.js';
import { listPlans, createPlan, updatePlan } from '../../controllers/adminPlansController.js';
import { getPlatformConfig, updatePlatformConfig } from '../../controllers/adminPlatformConfigController.js';
import { listPromotions, createPromotion, updatePromotion } from '../../controllers/adminPromotionsController.js';
import { listShops } from '../../controllers/adminShopsController.js';
import { lookupShopByUser, getShopSubscription, reconcileShopPayment } from '../../controllers/adminSubscriptionsController.js';
import { listAuditLogs } from '../../controllers/adminAuditController.js';
import { listPushCampaigns, createPushCampaign, sendPushCampaign, cancelPushCampaign } from '../../controllers/adminPushController.js';
import { getCounties, getSubcounties } from '../../controllers/presetsController.js';
import { listAdmins, createAdmin, updateAdmin, deleteAdmin } from '../../controllers/adminManagementController.js';
import { protectAdmin, requireSuperAdmin, requirePermission } from '../../middlewares/adminAuth.js';
import validate from '../../middlewares/validate.js';
import { createRateLimitStore } from '../../utils/rateLimitStore.js';
import { ADMIN_MODULE_PERMISSIONS } from '../../constants/adminPermissions.js';
import {
  adminLoginSchema,
  createPlanSchema,
  updatePlanSchema,
  createPromotionSchema,
  updatePromotionSchema,
  updatePlatformConfigSchema,
  createPushCampaignSchema,
  createAdminUserSchema,
  updateAdminUserSchema,
} from '../../validations/adminValidation.js';

const router = express.Router();

// Same brute-force protection as the shop-facing login (see authRoutes.js) —
// this is a second exposed login endpoint and deserves the same limiter.
const adminLoginLimiter = rateLimit({
  standardHeaders: true,
  legacyHeaders: false,
  windowMs: 15 * 60 * 1000,
  max: 20,
  store: createRateLimitStore('admin-login'),
  message: { success: false, message: 'Too many login attempts. Please wait 15 minutes and try again.' },
});

router.post('/auth/login', adminLoginLimiter, validate(adminLoginSchema), login);

router.use(protectAdmin);

router.get('/auth/me', getProfile);

router.get('/plans', requirePermission('plans'), listPlans);
router.post('/plans', requirePermission('plans'), validate(createPlanSchema), createPlan);
router.patch('/plans/:id', requirePermission('plans'), validate(updatePlanSchema), updatePlan);

router.get('/platform-config', requirePermission('platform_config'), getPlatformConfig);
router.patch('/platform-config', requirePermission('platform_config'), validate(updatePlatformConfigSchema), updatePlatformConfig);

router.get('/promotions', requirePermission('promotions'), listPromotions);
router.post('/promotions', requirePermission('promotions'), validate(createPromotionSchema), createPromotion);
router.patch('/promotions/:id', requirePermission('promotions'), validate(updatePromotionSchema), updatePromotion);

router.get('/shops', requirePermission('shops'), listShops);
router.get('/shops/lookup', requirePermission('shops'), lookupShopByUser);
router.get('/shops/:id/subscription', requirePermission('shops'), getShopSubscription);
router.post('/subscriptions/payments/:paymentId/reconcile', requirePermission('shops'), reconcileShopPayment);
router.get('/audit', requirePermission('audit'), listAuditLogs);

router.get('/push-campaigns', requirePermission('push_campaigns'), listPushCampaigns);
router.post('/push-campaigns', requirePermission('push_campaigns'), validate(createPushCampaignSchema), createPushCampaign);
router.post('/push-campaigns/:id/send', requirePermission('push_campaigns'), sendPushCampaign);
router.patch('/push-campaigns/:id/cancel', requirePermission('push_campaigns'), cancelPushCampaign);

// Same Location-backed lookups as GET /presets/counties|subcounties, mirrored
// here since the admin web app calls through adminApi (separate base URL/auth).
// Ungated by module permission — shared reference data, not sensitive.
router.get('/locations/counties', getCounties);
router.get('/locations/subcounties', getSubcounties);

// Managing admin accounts is super_admin-only, hard-coded to role — never a
// grantable permission, to keep a restricted admin from ever escalating
// their own or another admin's access.
router.get('/permissions', requireSuperAdmin, (req, res) => res.json({ success: true, data: ADMIN_MODULE_PERMISSIONS }));
router.get('/admins', requireSuperAdmin, listAdmins);
router.post('/admins', requireSuperAdmin, validate(createAdminUserSchema), createAdmin);
router.patch('/admins/:id', requireSuperAdmin, validate(updateAdminUserSchema), updateAdmin);
router.delete('/admins/:id', requireSuperAdmin, deleteAdmin);

export default router;

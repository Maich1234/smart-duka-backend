import express from 'express';
import rateLimit from 'express-rate-limit';
import { login, getProfile } from '../../controllers/adminAuthController.js';
import { listPlans, createPlan, updatePlan } from '../../controllers/adminPlansController.js';
import { getPlatformConfig, updatePlatformConfig } from '../../controllers/adminPlatformConfigController.js';
import { listPromotions, createPromotion, updatePromotion } from '../../controllers/adminPromotionsController.js';
import { listShops } from '../../controllers/adminShopsController.js';
import { listAuditLogs } from '../../controllers/adminAuditController.js';
import { protectAdmin } from '../../middlewares/adminAuth.js';
import validate from '../../middlewares/validate.js';
import { createRateLimitStore } from '../../utils/rateLimitStore.js';
import {
  adminLoginSchema,
  createPlanSchema,
  updatePlanSchema,
  createPromotionSchema,
  updatePromotionSchema,
  updatePlatformConfigSchema,
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

router.get('/plans', listPlans);
router.post('/plans', validate(createPlanSchema), createPlan);
router.patch('/plans/:id', validate(updatePlanSchema), updatePlan);

router.get('/platform-config', getPlatformConfig);
router.patch('/platform-config', validate(updatePlatformConfigSchema), updatePlatformConfig);

router.get('/promotions', listPromotions);
router.post('/promotions', validate(createPromotionSchema), createPromotion);
router.patch('/promotions/:id', validate(updatePromotionSchema), updatePromotion);

router.get('/shops', listShops);
router.get('/audit', listAuditLogs);

export default router;

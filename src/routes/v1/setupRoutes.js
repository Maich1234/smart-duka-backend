import express from 'express';
import rateLimit from 'express-rate-limit';
import { getEmbeddedSetupStatus } from '../../controllers/setupController.js';
import { createRateLimitStore } from '../../utils/rateLimitStore.js';

const router = express.Router();

// Unauthenticated at the Express layer (see setupController.js) — rate-limited
// by IP like publicRoutes.js.
const setupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  store: createRateLimitStore('setup-status'),
  message: { success: false, message: 'Too many requests, please try again later' },
});

router.get('/status', setupLimiter, getEmbeddedSetupStatus);

export default router;

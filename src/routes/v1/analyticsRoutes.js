import express from 'express';
import { getDepletion } from '../../controllers/analyticsController.js';
import { protect, ownerOnly } from '../../middlewares/auth.js';
import { requireActiveSubscription } from '../../middlewares/requireActiveSubscription.js';
import { requireFeature } from '../../middlewares/requireFeature.js';

const router = express.Router();

router.use(protect, ownerOnly);
router.get('/depletion', requireActiveSubscription, requireFeature('advanced_analytics'), getDepletion);

export default router;

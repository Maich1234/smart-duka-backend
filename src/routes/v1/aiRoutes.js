import express from 'express';
import { getBusinessInsight } from '../../controllers/aiController.js';
import { protect, ownerOnly } from '../../middlewares/auth.js';
import { requireFeature } from '../../middlewares/requireFeature.js';

const router = express.Router();

router.use(protect, ownerOnly);

router.get('/insight', requireFeature('ai_insights'), getBusinessInsight);

export default router;

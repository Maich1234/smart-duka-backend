import express from 'express';
import { getBusinessInsight } from '../../controllers/aiController.js';
import { protect, ownerOnly } from '../../middlewares/auth.js';
import { requireActiveSubscription } from '../../middlewares/requireActiveSubscription.js';

const router = express.Router();

router.use(protect, ownerOnly);

router.get('/insight', requireActiveSubscription, getBusinessInsight);

export default router;

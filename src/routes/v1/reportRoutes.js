import express from 'express';
import { getSalesReport } from '../../controllers/reportController.js';
import { protect, ownerOnly } from '../../middlewares/auth.js';
import { requireActiveSubscription } from '../../middlewares/requireActiveSubscription.js';
import { requireFeature } from '../../middlewares/requireFeature.js';

const router = express.Router();

router.use(protect);
router.get('/sales', ownerOnly, requireActiveSubscription, requireFeature('reports'), getSalesReport);

export default router;

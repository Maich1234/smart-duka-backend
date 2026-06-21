import express from 'express';
import { dailySalesCheck, depletionAlerts } from '../../controllers/cronController.js';

const router = express.Router();

// No `protect` middleware — these are triggered by Vercel Cron, not a
// logged-in user. Each handler verifies the CRON_SECRET header itself.
router.get('/daily-sales-check', dailySalesCheck);
router.get('/depletion-alerts', depletionAlerts);

export default router;

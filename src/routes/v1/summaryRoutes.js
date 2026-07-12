import express from 'express';
import { getDailySummary, listDailySummaries } from '../../controllers/summaryController.js';
import { protect, ownerOnly } from '../../middlewares/auth.js';

const router = express.Router();

router.use(protect, ownerOnly);

router.get('/daily', listDailySummaries);
router.get('/daily/:date', getDailySummary);

export default router;

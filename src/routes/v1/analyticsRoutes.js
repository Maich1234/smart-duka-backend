import express from 'express';
import { getDepletion } from '../../controllers/analyticsController.js';
import { protect, ownerOnly } from '../../middlewares/auth.js';

const router = express.Router();

router.use(protect, ownerOnly);
router.get('/depletion', getDepletion);

export default router;

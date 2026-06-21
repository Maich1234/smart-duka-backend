import express from 'express';
import { getRatings, getRatingsSummary } from '../../controllers/ratingController.js';
import { protect, ownerOnly } from '../../middlewares/auth.js';

const router = express.Router();

router.use(protect, ownerOnly);
router.get('/', getRatings);
router.get('/summary', getRatingsSummary);

export default router;

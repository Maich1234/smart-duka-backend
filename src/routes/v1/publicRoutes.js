import express from 'express';
import rateLimit from 'express-rate-limit';
import { getPublicReceipt, submitPublicRating, verifyBookDocument } from '../../controllers/publicController.js';
import { createRateLimitStore } from '../../utils/rateLimitStore.js';

const router = express.Router();

// Unauthenticated endpoints reachable from a QR scan — rate-limited by IP
// since there's no auth/permission layer to lean on.
const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  store: createRateLimitStore('public'),
  message: { success: false, message: 'Too many requests, please try again later' },
});

router.use(publicLimiter);
router.get('/receipt/:token', getPublicReceipt);
router.post('/receipt/:token/rating', submitPublicRating);
// Reached by scanning the QR on a downloaded financial record.
router.get('/books/verify/:token', verifyBookDocument);

export default router;

import express from 'express';
import rateLimit from 'express-rate-limit';
import { getPublicReceipt, submitPublicRating, verifyBookDocument, submitContactMessage } from '../../controllers/publicController.js';
import { createRateLimitStore } from '../../utils/rateLimitStore.js';
import validate from '../../middlewares/validate.js';
import { contactMessageSchema } from '../../validations/publicValidation.js';

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

// Tighter than the general public limiter — this one sends an email per
// request, so it's the more expensive/abusable endpoint of the group.
const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: createRateLimitStore('public-contact'),
  message: { success: false, message: 'Too many messages sent. Please wait 15 minutes and try again.' },
});

router.use(publicLimiter);
router.get('/receipt/:token', getPublicReceipt);
router.post('/receipt/:token/rating', submitPublicRating);
// Reached by scanning the QR on a downloaded financial record.
router.get('/books/verify/:token', verifyBookDocument);
// The marketing site's contact form.
router.post('/contact', contactLimiter, validate(contactMessageSchema), submitContactMessage);

export default router;

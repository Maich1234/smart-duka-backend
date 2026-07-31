import express from 'express';
import { getSalesReport } from '../../controllers/reportController.js';
import { listBooks, getBook, downloadBook } from '../../controllers/bookController.js';
import { protect, ownerOnly } from '../../middlewares/auth.js';
import { requireActiveSubscription } from '../../middlewares/requireActiveSubscription.js';
import { requireFeature } from '../../middlewares/requireFeature.js';

const router = express.Router();

router.use(protect);
router.get('/sales', ownerOnly, requireActiveSubscription, requireFeature('reports'), getSalesReport);

/**
 * Business books — the shop's own financial records.
 *
 * Owner-only and subscription-gated, but deliberately *not* behind
 * requireFeature('books'). The spec reserves a `books` plan flag for a future
 * third tier; until that tier exists, gating on a flag no plan carries would
 * mean nobody could reach their own records. The spec is also explicit that
 * ledger posting is never gated — only output — and there is no separate
 * output tier to sell yet.
 */
router.get('/books', ownerOnly, requireActiveSubscription, listBooks);
router.get('/books/:key', ownerOnly, requireActiveSubscription, getBook);
router.get('/books/:key/download', ownerOnly, requireActiveSubscription, downloadBook);

export default router;

import express from 'express';
import {
  getBusinessOverview,
  getBusinessSales,
  getBusinessStaff,
  getBusinessProducts,
} from '../../controllers/businessOverviewController.js';
import { protect, ownerOnly } from '../../middlewares/auth.js';

const router = express.Router();

/**
 * Owner-only, and deliberately not behind requireActiveSubscription.
 *
 * These are read-only views of the shop's own capital, stock and staff
 * records. requirePaidShop's own reasoning applies: a locked shop must always
 * be able to see its own history — blocking that is hostile without being
 * persuasive, and an owner deciding whether to renew is exactly the person who
 * needs to see what the business is worth.
 */
router.use(protect, ownerOnly);

router.get('/overview', getBusinessOverview);
router.get('/sales', getBusinessSales);
router.get('/staff', getBusinessStaff);
router.get('/products', getBusinessProducts);

export default router;

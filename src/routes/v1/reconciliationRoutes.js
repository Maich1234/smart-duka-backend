import express from 'express';
import { getCashiers, getMonthly } from '../../controllers/reconciliationController.js';
import { protect, ownerOnly, staffOrOwner } from '../../middlewares/auth.js';
import { requireActiveSubscription } from '../../middlewares/requireActiveSubscription.js';
import { requireFeature } from '../../middlewares/requireFeature.js';
import validate from '../../middlewares/validate.js';
import {
  cashierReconciliationQuerySchema,
  monthlyReconciliationQuerySchema,
} from '../../validations/reconciliationValidation.js';

const router = express.Router();

router.use(protect, requireActiveSubscription, requireFeature('reports'));

router.get('/cashiers', staffOrOwner, validate(cashierReconciliationQuerySchema, 'query'), getCashiers);
router.get('/monthly', ownerOnly, validate(monthlyReconciliationQuerySchema, 'query'), getMonthly);

export default router;

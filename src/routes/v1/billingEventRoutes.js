import express from 'express';
import { handleBillingEventDispatch } from '../../controllers/billingEventController.js';

const router = express.Router();

// QStash posts here for every published billing event — public, no JWT,
// verified entirely via the upstash-signature header (see
// billingEventController.js).
router.post('/dispatch', handleBillingEventDispatch);

export default router;

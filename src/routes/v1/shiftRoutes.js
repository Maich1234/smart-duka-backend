import express from 'express';
import {
  startShift,
  endShift,
  getMyActiveShift,
  getShifts,
  getShiftById,
} from '../../controllers/shiftController.js';
import { protect, staffOrOwner } from '../../middlewares/auth.js';
import { requirePaidShop } from '../../middlewares/requirePaidShop.js';
import validate from '../../middlewares/validate.js';
import idempotency from '../../middlewares/idempotency.js';
import {
  startShiftSchema,
  endShiftSchema,
  shiftQuerySchema,
} from '../../validations/shiftValidation.js';

const router = express.Router();

router.use(protect);

// idempotency on start/end: both can be queued offline and retried — start
// must not open two sessions, end must not re-reconcile or re-notify.
// requirePaidShop only on start: a locked shop shouldn't open a new till
// session, but an already-open one must still be closeable for reconciliation.
router.post('/start', staffOrOwner, requirePaidShop, idempotency, validate(startShiftSchema), startShift);
// :id may be 'current' (caller's active shift) or a shift id (owner force-close).
router.post('/:id/end', staffOrOwner, idempotency, validate(endShiftSchema), endShift);
router.get('/active', staffOrOwner, getMyActiveShift);
router.get('/', staffOrOwner, validate(shiftQuerySchema, 'query'), getShifts);
router.get('/:id', staffOrOwner, getShiftById);

export default router;

import express from 'express';
import {
  startShift,
  endShift,
  getMyActiveShift,
  getShifts,
  getShiftById,
} from '../../controllers/shiftController.js';
import { protect, staffOrOwner } from '../../middlewares/auth.js';
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
router.post('/start', staffOrOwner, idempotency, validate(startShiftSchema), startShift);
// :id may be 'current' (caller's active shift) or a shift id (owner force-close).
router.post('/:id/end', staffOrOwner, idempotency, validate(endShiftSchema), endShift);
router.get('/active', staffOrOwner, getMyActiveShift);
router.get('/', staffOrOwner, validate(shiftQuerySchema, 'query'), getShifts);
router.get('/:id', staffOrOwner, getShiftById);

export default router;

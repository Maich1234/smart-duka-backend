import express from 'express';
import {
  getStaff,
  getStaffById,
  createStaff,
  updateStaff,
  deleteStaff,
  resetStaffPassword,
  forceLogoutStaff,
  getStaffSales,
  getStaffCommission,
  updateStaffPermissions,
  checkStaffEmailAvailability,
} from '../../controllers/staffController.js';
import {
  initiateSeatPayment,
  getSeatPaymentStatus,
  recheckSeatPayment,
  reconcileSeatPaymentByMessage,
} from '../../controllers/seatPaymentController.js';
import { getAllPermissions } from '../../controllers/permissionController.js';
import { protect, ownerOnly } from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import idempotency from '../../middlewares/idempotency.js';
import {
  createStaffSchema,
  updateStaffSchema,
  resetPasswordSchema,
  updateStaffPermissionsSchema,
  initiateSeatPaymentSchema,
  seatPaymentReconcileSchema,
} from '../../validations/staffValidation.js';

const router = express.Router();

router.use(protect);
router.use(ownerOnly);

router.get('/permissions', getAllPermissions);
router.get('/', getStaff);
router.get('/check-email', checkStaffEmailAvailability);
router.post('/seat-payment', idempotency, validate(initiateSeatPaymentSchema), initiateSeatPayment);
router.get('/seat-payment/:paymentId', getSeatPaymentStatus);
router.post('/seat-payment/:paymentId/recheck', recheckSeatPayment);
router.post('/seat-payment/reconcile', validate(seatPaymentReconcileSchema), reconcileSeatPaymentByMessage);
router.get('/:id', getStaffById);
router.post('/', validate(createStaffSchema), createStaff);
router.put('/:id', validate(updateStaffSchema), updateStaff);
router.delete('/:id', deleteStaff);
router.post('/:id/reset-password', validate(resetPasswordSchema), resetStaffPassword);
router.post('/:id/force-logout', forceLogoutStaff);
router.get('/:id/sales', getStaffSales);
router.get('/:id/commission', getStaffCommission);
router.put('/:id/permissions', validate(updateStaffPermissionsSchema), updateStaffPermissions);

export default router;
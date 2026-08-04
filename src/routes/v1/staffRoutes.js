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
  previewSeatAddition,
} from '../../controllers/staffController.js';
// Seat purchase is retired: seats are postpaid and prorated onto the next
// invoice (see seatBillingService). These endpoints stay mounted only long
// enough for in-flight payments made by older app builds to reconcile — no
// current client initiates one. Remove after one release.
import {
  initiateSeatPayment,
  getSeatPaymentStatus,
  recheckSeatPayment,
  reconcileSeatPaymentByMessage,
} from '../../controllers/seatPaymentController.js';
import { getAllPermissions } from '../../controllers/permissionController.js';
// Staff closure requests are owner-approved, so the approve/decline half of
// the flow lives on the owner-only staff router rather than under /auth/me.
import {
  listStaffDeletionRequests,
  approveStaffDeletionRequest,
  declineStaffDeletionRequest,
} from '../../controllers/auth/deleteAccount.js';
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
  declineStaffDeletionRequestSchema,
} from '../../validations/staffValidation.js';

const router = express.Router();

router.use(protect);
router.use(ownerOnly);

router.get('/permissions', getAllPermissions);
router.get('/', getStaff);
router.get('/check-email', checkStaffEmailAvailability);
router.get('/seat-preview', previewSeatAddition);
// Before '/:id' so 'deletion-requests' isn't swallowed as a staff id.
router.get('/deletion-requests', listStaffDeletionRequests);
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
router.post('/:id/deletion-request/approve', idempotency, approveStaffDeletionRequest);
router.post(
  '/:id/deletion-request/decline',
  idempotency,
  validate(declineStaffDeletionRequestSchema),
  declineStaffDeletionRequest,
);

export default router;
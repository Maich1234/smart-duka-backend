import express from 'express';
import {
  getStaff,
  getStaffById,
  createStaff,
  updateStaff,
  deleteStaff,
  resetStaffPassword,
  getStaffSales,
  updateStaffPermissions,
} from '../../controllers/staffController.js';
import { getAllPermissions } from '../../controllers/permissionController.js';
import { protect, ownerOnly } from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import {
  createStaffSchema,
  updateStaffSchema,
  resetPasswordSchema,
  updateStaffPermissionsSchema,
} from '../../validations/staffValidation.js';

const router = express.Router();

router.use(protect);
router.use(ownerOnly);

router.get('/permissions', getAllPermissions);
router.get('/', getStaff);
router.get('/:id', getStaffById);
router.post('/', validate(createStaffSchema), createStaff);
router.put('/:id', validate(updateStaffSchema), updateStaff);
router.delete('/:id', deleteStaff);
router.post('/:id/reset-password', validate(resetPasswordSchema), resetStaffPassword);
router.get('/:id/sales', getStaffSales);
router.put('/:id/permissions', validate(updateStaffPermissionsSchema), updateStaffPermissions);

export default router;
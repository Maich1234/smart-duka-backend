import express from 'express';
import { getOwnerDashboard, getStaffDashboard } from '../../controllers/dashboardController.js';
import { protect, ownerOnly, staffOrOwner } from '../../middlewares/auth.js';

const router = express.Router();

router.use(protect);
router.get('/owner', ownerOnly, getOwnerDashboard);
router.get('/staff', staffOrOwner, getStaffDashboard);

export default router;
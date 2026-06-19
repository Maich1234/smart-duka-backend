import express from 'express';
import { getSalesReport } from '../../controllers/reportController.js';
import { protect, ownerOnly } from '../../middlewares/auth.js';

const router = express.Router();

router.use(protect);
router.get('/sales', ownerOnly, getSalesReport);

export default router;

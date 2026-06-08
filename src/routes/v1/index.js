import express from 'express';
import authRoutes from './authRoutes.js';
import productRoutes from './productRoutes.js';
import saleRoutes from './saleRoutes.js';
import staffRoutes from './staffRoutes.js';
import dashboardRoutes from './dashboardRoutes.js';
import shopRoutes from './shopRoutes.js';

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/products', productRoutes);
router.use('/sales', saleRoutes);
router.use('/staff', staffRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/shop', shopRoutes);

export default router;
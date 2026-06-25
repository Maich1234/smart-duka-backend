import express from 'express';
import authRoutes from './authRoutes.js';
import productRoutes from './productRoutes.js';
import expenseRoutes from './expenseRoutes.js';
import saleRoutes from './saleRoutes.js';
import staffRoutes from './staffRoutes.js';
import dashboardRoutes from './dashboardRoutes.js';
import shopRoutes from './shopRoutes.js';
import reportRoutes from './reportRoutes.js';
import publicRoutes from './publicRoutes.js';
import ratingRoutes from './ratingRoutes.js';
import analyticsRoutes from './analyticsRoutes.js';
import cronRoutes from './cronRoutes.js';
import paymentConfigRoutes from './paymentConfigRoutes.js';
import otpRoutes from './otpRoutes.js';
import mpesaRoutes from './mpesaRoutes.js';

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/products', productRoutes);
router.use('/expenses', expenseRoutes);
router.use('/sales', saleRoutes);
router.use('/staff', staffRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/shop', shopRoutes);
router.use('/reports', reportRoutes);
router.use('/public', publicRoutes);
router.use('/ratings', ratingRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/cron', cronRoutes);
router.use('/payment-config', paymentConfigRoutes);
router.use('/otp', otpRoutes);
router.use('/mpesa', mpesaRoutes);

export default router;
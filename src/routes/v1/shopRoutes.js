import express from 'express';
import { getShopConfig, updateShopConfig } from '../../controllers/shopController.js';
import { protect, ownerOnly } from '../../middlewares/auth.js';

const router = express.Router();

router.use(protect);
router.get('/', getShopConfig);
router.put('/', ownerOnly, updateShopConfig);

export default router;
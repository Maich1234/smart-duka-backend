import express from 'express';
import { getShopConfig, updateShopConfig } from '../../controllers/shopController.js';
import { protect, ownerOnly } from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import { updateShopConfigSchema } from '../../validations/shopValidation.js';

const router = express.Router();

router.use(protect);
router.get('/', getShopConfig);
router.put('/', ownerOnly, validate(updateShopConfigSchema), updateShopConfig);

export default router;
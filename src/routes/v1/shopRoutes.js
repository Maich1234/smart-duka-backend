import express from 'express';
import { getShopConfig, updateShopConfig, uploadShopLogo } from '../../controllers/shopController.js';
import { protect, ownerOnly } from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import { updateShopConfigSchema } from '../../validations/shopValidation.js';
import upload from '../../middlewares/upload.js';

const router = express.Router();

router.use(protect);
router.get('/', getShopConfig);
router.put('/', ownerOnly, validate(updateShopConfigSchema), updateShopConfig);
router.post('/logo', ownerOnly, upload.single('logo'), uploadShopLogo);

export default router;
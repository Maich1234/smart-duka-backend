import express from 'express';
import { login, getProfile, updateProfile, changePassword } from '../../controllers/authController.js';
import { protect } from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import { loginSchema, changePasswordSchema } from '../../validations/authValidation.js';

const router = express.Router();

router.post('/login', validate(loginSchema), login);
router.get('/profile', protect, getProfile);
router.put('/profile', protect, updateProfile);
router.post('/change-password', protect, validate(changePasswordSchema), changePassword);

export default router;
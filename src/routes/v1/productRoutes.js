import express from 'express';
import {
  getProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  updateStock,
} from '../../controllers/productController.js';
import { protect, ownerOnly, staffOrOwner } from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import { createProductSchema, updateProductSchema, updateStockSchema } from '../../validations/productValidation.js';

const router = express.Router();

router.use(protect);
router.get('/', staffOrOwner, getProducts);
router.get('/:id', staffOrOwner, getProductById);
router.post('/', ownerOnly, validate(createProductSchema), createProduct);
router.put('/:id', ownerOnly, validate(updateProductSchema), updateProduct);
router.delete('/:id', ownerOnly, deleteProduct);
router.patch('/:id/stock', staffOrOwner, validate(updateStockSchema), updateStock); // stock update allowed for staff with permission

export default router;
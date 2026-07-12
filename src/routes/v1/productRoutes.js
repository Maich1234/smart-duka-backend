import express from 'express';
import {
  getProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  updateStock,
} from '../../controllers/productController.js';
import { protect, staffOrOwner } from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import idempotency from '../../middlewares/idempotency.js';
import { createProductSchema, updateProductSchema, updateStockSchema } from '../../validations/productValidation.js';

const router = express.Router();

router.use(protect);
router.get('/', staffOrOwner, getProducts);
router.get('/:id', staffOrOwner, getProductById);
// Role gate only checks authenticated staff-or-owner; createProduct/updateProduct/deleteProduct
// each enforce their own owner-or-permission check (create_product/edit_product/delete_product).
// idempotency: these are retried by the mobile offline queue — a retried
// create would otherwise insert the product twice.
router.post('/', staffOrOwner, idempotency, validate(createProductSchema), createProduct);
router.put('/:id', staffOrOwner, idempotency, validate(updateProductSchema), updateProduct);
router.delete('/:id', staffOrOwner, deleteProduct);
router.patch('/:id/stock', staffOrOwner, idempotency, validate(updateStockSchema), updateStock); // stock update allowed for staff with permission

export default router;
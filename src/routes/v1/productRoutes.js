import { uploadSpreadsheet, getProductImport, downloadImportTemplate, previewProductImport, commitProductImport } from '../../controllers/productImportController.js';
import rateLimit from 'express-rate-limit';
import { getProductPriceHealth, getProductPriceHistory, downloadPriceHealth } from '../../controllers/priceHealthController.js';
import express from 'express';
import {
  getProducts,
  getProductCategories,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  updateStock,
} from '../../controllers/productController.js';
import { protect, staffOrOwner, ownerOnly } from '../../middlewares/auth.js';
import { requirePaidShop } from '../../middlewares/requirePaidShop.js';
import validate from '../../middlewares/validate.js';
import idempotency from '../../middlewares/idempotency.js';
import { createProductSchema, updateProductSchema, updateStockSchema } from '../../validations/productValidation.js';

const router = express.Router();

router.use(protect);
router.get('/', staffOrOwner, getProducts);
// Must precede '/:id' — otherwise Express matches "categories" as an id.
router.get('/categories', staffOrOwner, getProductCategories);
const importLimiter = rateLimit({ windowMs: 60000, limit: 5, keyGenerator: req => String(req.user._id), standardHeaders: true, legacyHeaders: false, message: { success: false, code: 'IMPORT_RATE_LIMITED', message: 'Too many import attempts. Wait one minute, then retry this preview.' } });
router.get('/import/template', ownerOnly, downloadImportTemplate);
router.get('/import/:batchId', ownerOnly, getProductImport);
router.post('/import/preview', ownerOnly, requirePaidShop, importLimiter, uploadSpreadsheet, previewProductImport);
router.post('/import/:batchId/commit', ownerOnly, requirePaidShop, importLimiter, commitProductImport);
router.get('/price-health/pdf', ownerOnly, downloadPriceHealth);
router.get('/price-health', ownerOnly, getProductPriceHealth);
router.get('/:id/price-history', ownerOnly, getProductPriceHistory);
router.get('/:id', staffOrOwner, getProductById);
// Role gate only checks authenticated staff-or-owner; createProduct/updateProduct/deleteProduct
// each enforce their own owner-or-permission check (create_product/edit_product/delete_product).
// idempotency: these are retried by the mobile offline queue — a retried
// create would otherwise insert the product twice.
router.post('/', staffOrOwner, requirePaidShop, idempotency, validate(createProductSchema), createProduct);
router.put('/:id', staffOrOwner, requirePaidShop, idempotency, validate(updateProductSchema), updateProduct);
router.delete('/:id', staffOrOwner, requirePaidShop, deleteProduct);
router.patch('/:id/stock', staffOrOwner, requirePaidShop, idempotency, validate(updateStockSchema), updateStock); // stock update allowed for staff with permission

export default router;
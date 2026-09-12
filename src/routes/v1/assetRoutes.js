import express from 'express';
import { getAssets, createAsset, updateAsset } from '../../controllers/assetController.js';
import { protect, ownerOnly } from '../../middlewares/auth.js';
import { requirePaidShop } from '../../middlewares/requirePaidShop.js';
import validate from '../../middlewares/validate.js';
import idempotency from '../../middlewares/idempotency.js';
import { createAssetSchema, updateAssetSchema } from '../../validations/assetValidation.js';

const router = express.Router();

/**
 * Business assets. Owner-only: what the shop owns and what it is worth is
 * owner-private, the same way costPrice is.
 *
 * `idempotency` because the mobile offline outbox retries writes — without it
 * a fridge recorded on a dead connection can arrive twice. There is no DELETE:
 * assets feed a figure an owner may have shown a lender, so removal is an
 * archive (PUT with `archived: true`) that hides the row and drops it out of
 * the capital total without destroying the record.
 */
router.use(protect, ownerOnly);

// Reads stay ungated: requirePaidShop's own reasoning is that a locked shop
// must always be able to see its own history. Writes carry the same gate as
// expenses, purchases and sales, so a lapsed shop cannot keep filing records
// indefinitely while every other write in the app is closed to it.
router.get('/', getAssets);
router.post('/', requirePaidShop, idempotency, validate(createAssetSchema), createAsset);
router.put('/:id', requirePaidShop, idempotency, validate(updateAssetSchema), updateAsset);

export default router;

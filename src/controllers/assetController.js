import Asset, { assetUnitValue, LIVE_ASSET_MATCH } from '../models/Asset.js';
import { parsePagination } from '../utils/pagination.js';

/**
 * The shop's own fixed assets — owner-only throughout.
 *
 * Every query is scoped by `req.user.shop._id`, never by anything the client
 * sends, and every single-record lookup matches on `{ _id, shop }` together so
 * an id guessed from another shop resolves to a 404 rather than a record.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Adds the two derived figures the UI needs on every row, from one shared
 * definition, so a list row can never disagree with the capital total it
 * feeds: what the line is worth, and whether that came from a current
 * estimate or is standing in at the purchase price.
 */
const present = (doc) => {
  const asset = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  const { value, basis } = assetUnitValue(asset);
  return {
    ...asset,
    estimatedValue: round2(value * (asset.quantity ?? 1)),
    valueBasis: basis,
  };
};

export const getAssets = async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const includeArchived = req.query.includeArchived === 'true';

  const query = {
    shop: req.user.shop._id,
    ...(includeArchived ? {} : { archivedAt: null }),
  };

  const [assets, total] = await Promise.all([
    Asset.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Asset.countDocuments(query),
  ]);

  // Live-only totals even when archived rows are being shown, so the header
  // figure matches the one on the Overview tab.
  const [summary] = await Asset.aggregate([
    { $match: { shop: req.user.shop._id, ...LIVE_ASSET_MATCH } },
    { $group: { _id: null, count: { $sum: 1 } } },
  ]);

  res.json({
    success: true,
    data: assets.map(present),
    summary: { liveCount: summary?.count ?? 0 },
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
};

export const createAsset = async (req, res) => {
  const asset = await Asset.create({
    ...req.body,
    shop: req.user.shop._id,
    recordedBy: req.user._id,
  });
  res.status(201).json({ success: true, data: present(asset) });
};

export const updateAsset = async (req, res) => {
  const { archived, ...fields } = req.body;

  const update = { ...fields };
  if (archived !== undefined) {
    update.archivedAt = archived ? new Date() : null;
  }

  const asset = await Asset.findOneAndUpdate(
    { _id: req.params.id, shop: req.user.shop._id },
    update,
    { new: true, runValidators: true },
  );
  if (!asset) {
    return res.status(404).json({ success: false, message: 'Asset not found' });
  }

  res.json({ success: true, data: present(asset) });
};

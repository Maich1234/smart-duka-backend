import mongoose from 'mongoose';
import multer from 'multer';
import Product from '../models/Product.js';
import ProductPriceChange from '../models/ProductPriceChange.js';
import ProductImportBatch from '../models/ProductImportBatch.js';
import { duplicateErrors } from '../services/productDuplicates.js';
const importError = message => Object.assign(new Error(message), { status: 400 });
import { buildProductPriceChange } from '../services/productPriceHistoryService.js';
import { lockCatalogue } from '../services/catalogueLock.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0, parts: 2 }, fileFilter: (_req, file, cb) => cb(null, /\.(xls|xlsx)$/i.test(file.originalname)) }).single('file');
export function uploadSpreadsheet(req, res, next) { upload(req, res, err => err ? res.status(400).json({ success: false, message: 'Upload one .xls or .xlsx file, up to 5 MB.' }) : next()); }
export async function downloadImportTemplate(req, res) {
  const { template } = await import('../services/productSpreadsheet.js');
  const format = req.query.format === 'xls' ? 'xls' : 'xlsx';
  res.set({ 'Content-Type': format === 'xls' ? 'application/vnd.ms-excel' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="duqana-products-template.${format}"`, 'Cache-Control': 'private, no-store' }).send(template(format));
}
export async function previewProductImport(req, res) {
  if (!req.file) throw importError('Choose a .xls or .xlsx file, up to 5 MB.');
  const shop = req.user.shop._id;
  const existing = await Product.find({ shop }).select('name sku barcode variants productType costPrice').lean();
  const { parseSpreadsheet } = await import('../services/productSpreadsheet.js');
  const parsed = parseSpreadsheet(req.file.buffer, existing);
  const batch = await ProductImportBatch.create({ shop, owner: req.user._id, products: parsed.products, rows: parsed.rows, componentCosts: parsed.componentCosts, warnings: parsed.warnings, expiresAt: new Date(Date.now() + 86400000) });
  res.json({ success: true, data: { batchId: batch._id, count: parsed.products.length, rows: parsed.rows, warnings: parsed.warnings, canCommit: parsed.canCommit, expiresAt: batch.expiresAt } });
}
export async function commitProductImport(req, res) {
  if (!mongoose.isValidObjectId(req.params.batchId)) throw importError('Invalid import preview.');
  const session = await mongoose.startSession(); let count = 0, replayed = false;
  try {
    await session.withTransaction(async () => {
      const shop = req.user.shop._id;
      await lockCatalogue(shop, session);
      const batch = await ProductImportBatch.findOne({ _id: req.params.batchId, shop, owner: req.user._id }).session(session);
      if (!batch) throw Object.assign(new Error('Import preview not found.'), { status: 404 });
      count = batch.products.length;
      if (batch.status === 'committed') { replayed = true; return; }
      if (batch.expiresAt <= new Date()) throw importError('Preview expired. Upload the spreadsheet again.');
      if (!count || batch.rows.some(row => row.errors.length)) throw importError('Fix all preview errors and upload again.');
      if (batch.warnings.length && req.body?.acknowledgeWarnings !== true) throw importError('Review and acknowledge below-cost warnings before saving.');
      const existing = await Product.find({ shop }).select('name sku barcode variants productType costPrice').session(session).lean();
      const currentCosts = new Map(existing.map(p => [String(p._id), Number.isFinite(p.costPrice) ? p.costPrice : null]));
      if (batch.componentCosts.some(row => !currentCosts.has(String(row.product)) || currentCosts.get(String(row.product)) !== row.costPrice)) throw Object.assign(new Error('A bundle component cost changed since preview. Upload again to review the current prices.'), { status: 409 });
      const conflicts = duplicateErrors(batch.products, existing);
      if (conflicts.length) throw Object.assign(new Error(`Catalogue changed since preview. ${conflicts[0]} Upload again.`), { status: 409 });
      const ids = new Set([...existing, ...batch.products].filter(p => ['standard', 'weighted', 'refillable'].includes(p.productType ?? 'standard')).map(p => String(p._id)));
      if (batch.products.some(p => p.bundleItems?.some(b => !ids.has(String(b.product))))) throw importError('A bundle component was removed. Upload again.');
      const created = await Product.insertMany(batch.products.map(p => ({ ...p, shop })), { session, ordered: true });
      await ProductPriceChange.insertMany(created.map(after => buildProductPriceChange({ after, actor: req.user, source: 'created' })), { session });
      batch.status = 'committed'; batch.committedAt = new Date(); await batch.save({ session });
    });
  } finally { await session.endSession(); }
  res.json({ success: true, data: { count, replayed }, message: `${count} products added${replayed ? ' previously; no duplicates created' : ''}.` });
}

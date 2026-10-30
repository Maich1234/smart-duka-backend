import mongoose from 'mongoose';
import multer from 'multer';
import Product from '../models/Product.js';
import ProductPriceChange from '../models/ProductPriceChange.js';
import ProductImportBatch from '../models/ProductImportBatch.js';
import { duplicateErrors } from '../services/productDuplicates.js';
const importError = message => Object.assign(new Error(message), { status: 400 });
import { buildProductPriceChange } from '../services/productPriceHistoryService.js';
import { lockCatalogue } from '../services/catalogueLock.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0, parts: 2 }, fileFilter: (_req, file, cb) => {
  if (!/\.(xls|xlsx)$/i.test(file.originalname)) return cb(importError('This file type is not supported. Save your spreadsheet as .xls or .xlsx and choose it again.'));
  cb(null, true);
} }).single('file');
export function uploadSpreadsheet(req, res, next) {
  upload(req, res, err => {
    if (!err) return next();
    const reasons = {
      LIMIT_FILE_SIZE: [413, 'IMPORT_FILE_TOO_LARGE', 'The file is larger than 5 MB. Split it into smaller files and upload one at a time.'],
      LIMIT_FILE_COUNT: [400, 'IMPORT_TOO_MANY_FILES', 'Only one Excel file can be checked at a time. Choose one file and retry.'],
      LIMIT_UNEXPECTED_FILE: [400, 'IMPORT_UNEXPECTED_FILE', 'Choose one Excel file using the file picker and retry.'],
      LIMIT_FIELD_COUNT: [400, 'IMPORT_UNEXPECTED_FIELDS', 'The upload contains unexpected fields. Choose only the Excel file and retry.'],
      LIMIT_PART_COUNT: [400, 'IMPORT_TOO_MANY_PARTS', 'Upload only one Excel file per preview.'],
    };
    const [status, code, message] = reasons[err.code] ?? [400, 'IMPORT_INVALID_UPLOAD', err.status === 400 ? err.message : 'The upload was incomplete. Choose the file again and retry.'];
    res.status(status).json({ success: false, code, message });
  });
}
const previewData = batch => ({ batchId: batch._id, status: batch.status, count: batch.products.length, rows: batch.rows, warnings: batch.warnings, canCommit: batch.rows.every(row => !row.errors.length) && batch.products.length > 0, expiresAt: batch.expiresAt });
export async function getProductImport(req, res) {
  if (!mongoose.isValidObjectId(req.params.batchId)) throw importError('This preview link is invalid. Upload the spreadsheet again.');
  const batch = await ProductImportBatch.findOne({ _id: req.params.batchId, shop: req.user.shop._id, owner: req.user._id }).select('status rows warnings expiresAt products._id');
  if (!batch) return res.status(404).json({ success: false, code: 'IMPORT_PREVIEW_NOT_FOUND', message: 'This preview is no longer available. Check inventory, then upload the spreadsheet again if needed.' });
  if (batch.status !== 'committed' && batch.expiresAt <= new Date()) return res.status(410).json({ success: false, code: 'IMPORT_PREVIEW_EXPIRED', message: 'This preview expired after 24 hours. Upload the spreadsheet again to check it.' });
  res.json({ success: true, data: previewData(batch) });
}
export async function downloadImportTemplate(req, res) {
  const { template } = await import('../services/productSpreadsheet.js');
  const format = req.query.format === 'xls' ? 'xls' : 'xlsx';
  res.set({ 'Content-Type': format === 'xls' ? 'application/vnd.ms-excel' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="duqana-products-template.${format}"`, 'Cache-Control': 'private, no-store' }).send(template(format));
}
export async function previewProductImport(req, res) {
  if (req.file?.size === 0) throw importError('The selected file is empty. Add your products, save the spreadsheet and choose it again.');
  if (!req.file) throw importError('Choose a .xls or .xlsx file, up to 5 MB.');
  const shop = req.user.shop._id;
  const existing = await Product.find({ shop }).select('name sku barcode variants productType costPrice').lean();
  const { parseSpreadsheet } = await import('../services/productSpreadsheet.js');
  const parsed = parseSpreadsheet(req.file.buffer, existing);
  const batch = await ProductImportBatch.create({ shop, owner: req.user._id, products: parsed.products, rows: parsed.rows, componentCosts: parsed.componentCosts, warnings: parsed.warnings, expiresAt: new Date(Date.now() + 86400000) });
  res.json({ success: true, data: previewData(batch) });
}
export async function commitProductImport(req, res) {
  if (!mongoose.isValidObjectId(req.params.batchId)) throw importError('Invalid import preview.');
  const session = await mongoose.startSession(); let count = 0, replayed = false;
  try {
    await session.withTransaction(async () => {
      const shop = req.user.shop._id;
      await lockCatalogue(shop, session);
      const batch = await ProductImportBatch.findOne({ _id: req.params.batchId, shop, owner: req.user._id }).session(session);
      if (!batch) throw Object.assign(new Error('Import preview not found.'), { status: 404, publicCode: 'IMPORT_PREVIEW_NOT_FOUND' });
      count = batch.products.length;
      if (batch.status === 'committed') { replayed = true; return; }
      if (batch.expiresAt <= new Date()) throw Object.assign(importError('Preview expired after 24 hours. Upload the spreadsheet again.'), { status: 410, publicCode: 'IMPORT_PREVIEW_EXPIRED' });
      if (!count || batch.rows.some(row => row.errors.length)) throw importError('Fix all preview errors and upload again.');
      if (batch.warnings.length && req.body?.acknowledgeWarnings !== true) throw importError('Review and acknowledge below-cost warnings before saving.');
      const existing = await Product.find({ shop }).select('name sku barcode variants productType costPrice').session(session).lean();
      const currentCosts = new Map(existing.map(p => [String(p._id), Number.isFinite(p.costPrice) ? p.costPrice : null]));
      if (batch.componentCosts.some(row => !currentCosts.has(String(row.product)) || currentCosts.get(String(row.product)) !== row.costPrice)) throw Object.assign(new Error('A bundle component cost changed since preview. Upload again to review the current prices.'), { status: 409, publicCode: 'IMPORT_CATALOGUE_CHANGED' });
      const conflicts = duplicateErrors(batch.products, existing);
      if (conflicts.length) throw Object.assign(new Error(`Catalogue changed since preview. ${conflicts[0]} Upload again.`), { status: 409, publicCode: 'IMPORT_CATALOGUE_CHANGED' });
      const ids = new Set([...existing, ...batch.products].filter(p => ['standard', 'weighted', 'refillable'].includes(p.productType ?? 'standard')).map(p => String(p._id)));
      if (batch.products.some(p => p.bundleItems?.some(b => !ids.has(String(b.product))))) throw importError('A bundle component was removed. Upload again.');
      const created = await Product.insertMany(batch.products.map(p => ({ ...p, shop })), { session, ordered: true });
      await ProductPriceChange.insertMany(created.map(after => buildProductPriceChange({ after, actor: req.user, source: 'created' })), { session });
      batch.status = 'committed'; batch.committedAt = new Date(); await batch.save({ session });
    });
  } finally { await session.endSession(); }
  res.json({ success: true, data: { count, replayed }, message: `${count} product${count === 1 ? '' : 's'} added${replayed ? ' previously; no duplicates created' : ''}.` });
}

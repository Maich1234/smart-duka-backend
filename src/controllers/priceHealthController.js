import mongoose from 'mongoose';
import Product from '../models/Product.js';
import ProductPriceChange from '../models/ProductPriceChange.js';
import { getPriceHealth } from '../services/priceHealthService.js';
export async function getProductPriceHealth(req, res) {
  res.json({ success: true, data: await getPriceHealth(req.user.shop._id, req.query) });
}
export async function getProductPriceHistory(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid product.' });
  const shop = req.user.shop._id;
  if (!await Product.exists({ _id: req.params.id, shop })) return res.status(404).json({ success: false, message: 'Product not found.' });
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1), limit = 20;
  const query = { shop, product: req.params.id };
  const [data, total] = await Promise.all([ProductPriceChange.find(query).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(), ProductPriceChange.countDocuments(query)]);
  res.json({ success: true, data, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
}

export async function downloadPriceHealth(req, res) {
  const { renderPriceHealthPdf } = await import('../services/priceHealthPdf.js');
  const Shop = (await import('../models/Shop.js')).default;
  const report = await getPriceHealth(req.user.shop._id, req.query, { exportLimit: 10000 });
  if (report.pagination.total > report.items.length) return res.status(422).json({ success: false, message: 'This report exceeds 10,000 price alerts. Review the catalogue before exporting.' });
  const shop = await Shop.findById(req.user.shop._id).select('name currency').lean();
  const pdf = await renderPriceHealthPdf(report, shop);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="duqana-price-review.pdf"', 'Cache-Control': 'private, no-store' }).send(pdf);
}

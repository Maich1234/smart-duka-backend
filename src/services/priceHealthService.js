import mongoose from 'mongoose';
import { createHash } from 'node:crypto';
import Product from '../models/Product.js';
import Sale from '../models/Sale.js';
import Shop from '../models/Shop.js';
import ProductPriceChange from '../models/ProductPriceChange.js';

const round = n => Math.round((n ?? 0) * 100) / 100;
const finiteNumber = field => ({ $and: [{ $isNumber: field }, { $gte: [field, -Number.MAX_SAFE_INTEGER] }, { $lte: [field, Number.MAX_SAFE_INTEGER] }] });
const safeNumber = field => ({ $cond: [finiteNumber(field), field, 0] });
const positiveCost = field => ({ $and: [finiteNumber(field), { $gt: [field, 0] }] });
const arrayOrEmpty = field => ({ $cond: [{ $isArray: field }, field, []] });
const supplied = field => ({ $ne: [{ $ifNull: [field, null] }, null] });

/** Owner-only financial data. Mongo facets count the full catalogue before paging. */
export async function getPriceHealth(shopId, { page = 1, limit = 20, days = 30 } = {}, { exportLimit = 0 } = {}) {
  const shop = new mongoose.Types.ObjectId(String(shopId));
  page = exportLimit ? 1 : Math.max(1, Math.min(100000, Number.parseInt(page, 10) || 1));
  limit = exportLimit ? Math.min(10000, exportLimit) : Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 20));
  days = Math.max(1, Math.min(90, Number.parseInt(days, 10) || 30));
  const end = new Date(), start = new Date(end.getTime() - days * 86400000);
  const inventory = [
    { $match: { shop } },
    { $lookup: { from: 'products', localField: 'bundleItems.product', foreignField: '_id', pipeline: [{ $match: { shop } }, { $project: { costPrice: 1 } }], as: 'components' } },
    { $set: { componentCostKnown: { $and: [{ $gt: [{ $size: arrayOrEmpty('$bundleItems') }, 0] }, { $allElementsTrue: [{ $map: { input: arrayOrEmpty('$bundleItems'), as: 'b', in: { $let: { vars: { c: { $arrayElemAt: [{ $filter: { input: '$components', as: 'c', cond: { $eq: ['$$c._id', '$$b.product'] } } }, 0] } }, in: { $and: [positiveCost('$$c.costPrice'), positiveCost('$$b.quantity')] } } } } }] }] },
      componentCost: { $sum: { $map: { input: arrayOrEmpty('$bundleItems'), as: 'b', in: { $let: { vars: { c: { $arrayElemAt: [{ $filter: { input: '$components', as: 'c', cond: { $eq: ['$$c._id', '$$b.product'] } } }, 0] } }, in: { $multiply: [safeNumber('$$c.costPrice'), safeNumber('$$b.quantity')] } } } } } } } },
    { $set: { rows: { $cond: [{ $and: [{ $eq: ['$productType', 'configurable'] }, { $gt: [{ $size: arrayOrEmpty('$variants') }, 0] }] }, { $map: { input: arrayOrEmpty('$variants'), as: 'v', in: { key: { $toString: '$$v._id' }, variantId: '$$v._id', variantName: '$$v.name', sellingPrice: '$$v.sellingPrice', costPrice: '$$v.costPrice', quantity: '$$v.quantity' } } }, [{ key: 'base', sellingPrice: '$sellingPrice', costPrice: { $cond: [{ $eq: ['$productType', 'bundle'] }, { $cond: ['$componentCostKnown', '$componentCost', null] }, '$costPrice'] }, quantity: '$quantity' }]] } } },
    { $unwind: '$rows' },
    { $set: { costKnown: { $or: [positiveCost('$rows.costPrice'), { $and: [{ $eq: ['$productType', 'service'] }, finiteNumber('$rows.costPrice'), { $gte: ['$rows.costPrice', 0] }] }] }, stockKnown: { $or: [{ $eq: ['$trackInventory', false] }, finiteNumber('$rows.quantity')] }, flexible: { $or: [{ $eq: ['$productType', 'variable'] }, { $and: [{ $eq: ['$productType', 'service'] }, '$allowPriceOverride'] }] } } },
    { $set: { issues: { $concatArrays: [
      { $cond: [{ $and: [{ $eq: ['$productType', 'configurable'] }, { $eq: [{ $size: arrayOrEmpty('$variants') }, 0] }] }, ['missing_variants'], []] },
      { $cond: [{ $or: [{ $not: [finiteNumber('$rows.sellingPrice')] }, { $lte: ['$rows.sellingPrice', 0] }] }, ['zero_or_missing_price'], []] },
      { $cond: [{ $and: ['$costKnown', finiteNumber('$rows.sellingPrice'), { $lt: ['$rows.sellingPrice', '$rows.costPrice'] }] }, ['below_cost'], []] },
      { $cond: [{ $and: ['$costKnown', '$flexible', finiteNumber('$minPrice'), { $lt: ['$minPrice', '$rows.costPrice'] }] }, ['minimum_below_cost'], []] },
      { $cond: [{ $not: ['$costKnown'] }, ['cost_not_set'], []] },
      { $cond: [{ $not: ['$stockKnown'] }, ['invalid_stock_quantity'], []] },
      { $cond: [{ $and: ['$flexible', { $or: [
        { $and: [supplied('$minPrice'), { $or: [{ $not: [finiteNumber('$minPrice')] }, { $lt: ['$minPrice', 0] }] }] },
        { $and: [supplied('$maxPrice'), { $or: [{ $not: [finiteNumber('$maxPrice')] }, { $lt: ['$maxPrice', 0] }] }] },
        { $and: [finiteNumber('$minPrice'), finiteNumber('$maxPrice'), { $lt: ['$maxPrice', '$minPrice'] }] },
      ] }] }, ['invalid_price_range'], []] },
    ] } } },
    { $match: { 'issues.0': { $exists: true } } },
    { $set: { unitShortfall: { $cond: [{ $and: ['$costKnown', finiteNumber('$rows.sellingPrice')] }, { $max: [0, { $subtract: ['$rows.costPrice', '$rows.sellingPrice'] }] }, null] },
      stockQuantity: { $cond: [{ $eq: ['$trackInventory', false] }, 0, { $max: [0, safeNumber('$rows.quantity')] }] } } },
    { $set: { potentialLoss: { $cond: [{ $or: [{ $eq: ['$productType', 'bundle'] }, { $not: ['$stockKnown'] }, { $eq: ['$unitShortfall', null] }] }, null, { $multiply: ['$unitShortfall', '$stockQuantity'] }] },
      stockCostValue: { $cond: [{ $eq: ['$productType', 'bundle'] }, 0, { $multiply: [{ $cond: ['$costKnown', '$rows.costPrice', 0] }, '$stockQuantity'] }] } } },
    { $facet: {
      summary: [{ $group: { _id: null, productIds: { $addToSet: '$_id' }, affectedPriceRows: { $sum: 1 }, zeroPriceRows: { $sum: { $cond: [{ $in: ['zero_or_missing_price', '$issues'] }, 1, 0] } }, belowCostRows: { $sum: { $cond: [{ $in: ['below_cost', '$issues'] }, 1, 0] } }, missingCostRows: { $sum: { $cond: [{ $in: ['cost_not_set', '$issues'] }, 1, 0] } }, potentialLoss: { $sum: '$potentialLoss' }, affectedStockCostValue: { $sum: '$stockCostValue' }, excludedBundles: { $sum: { $cond: [{ $eq: ['$productType', 'bundle'] }, 1, 0] } } } }],
      items: [{ $sort: { potentialLoss: -1, name: 1, _id: 1, 'rows.key': 1 } }, { $skip: (page - 1) * limit }, { $limit: limit },
        { $lookup: { from: 'productpricechanges', let: { id: '$_id', key: '$rows.key' }, pipeline: [{ $match: { shop, $expr: { $and: [{ $eq: ['$product', '$$id'] }, { $in: ['$$key', '$changes.key'] }] } } }, { $sort: { createdAt: -1, _id: -1 } }, { $limit: 1 }, { $project: { actorName: 1, actor: 1, source: 1, createdAt: 1 } }], as: 'history' } },
        { $project: { _id: 0, productId: '$_id', name: 1, productType: 1, unitOfMeasure: 1, variantId: '$rows.variantId', variantName: '$rows.variantName', sellingPrice: '$rows.sellingPrice', costPrice: '$rows.costPrice', stockQuantity: 1, stockKnown: 1, issues: 1, unitShortfall: 1, potentialLoss: 1, flexible: 1, minPrice: 1, lastChange: { $ifNull: [{ $arrayElemAt: ['$history', 0] }, null] } } }],
    } },
  ];
  const [catalogue, losses, latest, business] = await Promise.all([
    Product.aggregate(inventory),
    Sale.aggregate([
      { $match: { shop, status: { $in: ['completed', 'refund_pending'] }, createdAt: { $gte: start, $lte: end } } }, { $unwind: '$items' },
      { $set: { known: { $and: [finiteNumber('$items.costTotal'), { $or: [{ $gt: ['$items.costTotal', 0] }, { $and: [{ $eq: ['$items.productType', 'service'] }, { $gte: ['$items.costTotal', 0] }] }] }, finiteNumber('$items.subtotal'), { $gte: ['$items.subtotal', 0] }] }, shortfall: { $max: [0, { $subtract: [safeNumber('$items.costTotal'), safeNumber('$items.subtotal')] }] } } },
      { $facet: {
        summary: [{ $group: { _id: null, recordedLoss: { $sum: { $cond: [{ $and: ['$known', { $ne: ['$items.costEstimated', true] }] }, '$shortfall', 0] } }, estimatedLoss: { $sum: { $cond: [{ $and: ['$known', { $eq: ['$items.costEstimated', true] }] }, '$shortfall', 0] } }, unknownCostLines: { $sum: { $cond: ['$known', 0, 1] } }, belowCostSaleLines: { $sum: { $cond: [{ $and: ['$known', { $gt: ['$shortfall', 0] }] }, 1, 0] } } } }],
        products: [{ $match: { known: true, shortfall: { $gt: 0 } } }, { $group: { _id: { productId: '$items.productId', variantId: '$items.variantId', name: '$items.productName', variantName: '$items.variantName' }, loss: { $sum: '$shortfall' }, quantity: { $sum: '$items.quantity' }, estimated: { $max: { $cond: [{ $eq: ['$items.costEstimated', true] }, 1, 0] } } } }, { $sort: { loss: -1 } }, { $limit: 10 }],
      } },
    ]),
    ProductPriceChange.findOne({ shop }).sort({ createdAt: -1, _id: -1 }).select('_id createdAt').lean(),
    Shop.findById(shop).select('currency').lean(),
  ]);
  const raw = catalogue[0]?.summary[0] ?? {};
  const summary = { affectedProducts: raw.productIds?.length ?? 0, affectedPriceRows: raw.affectedPriceRows ?? 0, zeroPriceRows: raw.zeroPriceRows ?? 0, belowCostRows: raw.belowCostRows ?? 0, missingCostRows: raw.missingCostRows ?? 0, potentialLoss: round(raw.potentialLoss), affectedStockCostValue: round(raw.affectedStockCostValue), excludedBundles: raw.excludedBundles ?? 0 };
  const sold = losses[0]?.summary[0] ?? {};
  const realised = { recordedLoss: round(sold.recordedLoss), estimatedLoss: round(sold.estimatedLoss), unknownCostLines: sold.unknownCostLines ?? 0, belowCostSaleLines: sold.belowCostSaleLines ?? 0, products: (losses[0]?.products ?? []).map(p => ({ ...p._id, loss: round(p.loss), quantity: p.quantity, estimated: !!p.estimated })) };
  const items = catalogue[0]?.items ?? [];
  const digest = createHash('sha256').update(JSON.stringify({ summary, realised, items, latest })).digest('hex');
  return { currency: business?.currency ?? 'KES', generatedAt: end.toISOString(), window: { days, start: start.toISOString(), end: end.toISOString() }, summary, realised, items, pagination: { page, limit, total: summary.affectedPriceRows, pages: Math.ceil(summary.affectedPriceRows / limit) }, digest,
    notes: 'Potential loss uses current selling prices and positive stock, before future discounts. Bundles are excluded from stock totals to avoid counting shared components twice. Recorded loss is gross shortfall on sales after discounts using saved sale costs, not net business loss. Missing or invalid costs, selling prices and stock quantities are excluded from exposure estimates. Review flexible or intentionally free prices before changing them.' };
}

import mongoose from 'mongoose';
import Purchase from '../models/Purchase.js';
import Product from '../models/Product.js';
import Supplier from '../models/Supplier.js';
import {
  applyPurchaseReceiptStock,
  reversePurchaseStock,
  resolvePurchaseTarget,
  PurchaseLineError,
} from '../services/purchaseStockService.js';
import { round2 } from '../services/purchaseCostAllocation.js';
import { getPurchaseStats, getPurchaseAnalytics } from '../services/purchaseSummaryService.js';
import { logAudit } from '../services/auditLogService.js';
import { parsePagination } from '../utils/pagination.js';
import { escapeRegex } from '../utils/escapeRegex.js';

import { canViewPurchasePrices, presentPurchase } from '../services/purchaseVisibility.js';

/**
 * Builds the embedded items[] snapshot for a create/update, validating each
 * line's product/variant exists and is purchasable (via resolvePurchaseTarget)
 * along the way. Fetches each product at most once per call even if
 * referenced by more than one line.
 */
const buildPurchaseItems = async (rawItems, { shop, session }) => {
  const productCache = new Map();
  const getProduct = async (id) => {
    const key = id.toString();
    if (productCache.has(key)) return productCache.get(key);
    const doc = await Product.findOne({ _id: id, shop }).session(session);
    if (doc) productCache.set(key, doc);
    return doc;
  };

  let productsTotal = 0;
  const items = [];
  for (const raw of rawItems) {
    const product = await getProduct(raw.productId);
    if (!product) {
      throw new PurchaseLineError(`Product with ID ${raw.productId} not found in this shop`);
    }
    const target = resolvePurchaseTarget(product, raw);
    const totalCost = round2(raw.quantity * raw.unitCost);
    productsTotal += totalCost;
    items.push({
      productId: product._id,
      productName: product.name,
      quantity: raw.quantity,
      unitCost: raw.unitCost,
      totalCost,
      variantId: raw.variantId,
      variantName: product.productType === 'configurable' ? target.name : undefined,
      unitOfMeasure: product.unitOfMeasure,
    });
  }
  return { items, productsTotal: round2(productsTotal) };
};

const buildAdditionalCosts = (rawCosts, userId) => {
  const additionalCosts = (rawCosts || []).map((c) => ({
    category: c.category,
    description: c.description,
    amount: c.amount,
    notes: c.notes,
    createdBy: userId,
  }));
  return { additionalCosts, additionalCostsTotal: round2(additionalCosts.reduce((sum, c) => sum + c.amount, 0)) };
};

/**
 * A staffer's purchase needs an owner's sign-off before it touches stock if
 * they weren't granted 'update_inventory_on_purchase' at all, or if they were
 * specifically flagged with 'require_purchase_approval' (e.g. a newer hire
 * who's trusted to record purchases but not to move stock unsupervised).
 * Owners always bypass this — they're the approver.
 */
const needsOwnerApproval = (user) => user.role !== 'owner' && (
  !user.permissions?.includes('update_inventory_on_purchase') ||
  user.permissions?.includes('require_purchase_approval')
);

export const createPurchase = async (req, res) => {
  if (req.user.role !== 'owner' && !req.user.permissions?.includes('create_purchases')) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const { supplierId, supplierName, items, additionalCosts, paymentMethod, purchaseDate } = req.body;
  const shop = req.user.shop._id;

  let supplierDoc = null;
  if (supplierId) {
    supplierDoc = await Supplier.findOne({ _id: supplierId, shop });
    if (!supplierDoc) {
      return res.status(400).json({ success: false, message: 'Supplier not found in this shop' });
    }
  }

  const session = await mongoose.startSession();

  try {
    let purchase, built, grandTotal, requiresApproval;
    await session.withTransaction(async () => {
      built = await buildPurchaseItems(items, { shop, session });
      const { additionalCosts: costItems, additionalCostsTotal } = buildAdditionalCosts(additionalCosts, req.user._id);
      grandTotal = round2(built.productsTotal + additionalCostsTotal);
      requiresApproval = needsOwnerApproval(req.user);

      [purchase] = await Purchase.create([{
        shop,
        supplier: supplierDoc?._id,
        supplierName: supplierDoc?.name ?? supplierName ?? '',
        items: built.items,
        additionalCosts: costItems,
        productsTotal: built.productsTotal,
        additionalCostsTotal,
        grandTotal,
        allocationMethod: req.user.shop?.purchaseCostAllocationMethod ?? 'none',
        status: requiresApproval ? 'pending_approval' : 'completed',
        inventoryUpdated: !requiresApproval,
        staff: req.user._id,
        // Omitted by older clients and offline payloads queued before the field
        // existed — the schema default ('cash') covers those.
        ...(paymentMethod ? { paymentMethod } : {}),
        ...(purchaseDate ? { purchaseDate } : {}),
      }], { session });

      if (!requiresApproval) {
        await applyPurchaseReceiptStock(purchase, session);
      }
    });

    logAudit({
      shopId: shop,
      userId: req.user._id,
      action: 'purchase.created',
      entityType: 'Purchase',
      entityId: purchase._id,
      details: { grandTotal, itemCount: built.items.length, supplier: supplierDoc?.name ?? supplierName, status: purchase.status },
      req,
    }).catch(() => {});

    const data = presentPurchase(purchase, req.user);
    res.status(201).json({
      success: true,
      data,
      message: requiresApproval
        ? 'Purchase saved — waiting for owner approval before stock updates.'
        : 'Purchase recorded and stock updated.',
    });
  } catch (error) {
    if (error instanceof PurchaseLineError) return res.status(error.status).json({ success: false, message: error.message });
    throw error;
  } finally {
    await session.endSession();
  }
};

export const getPurchases = async (req, res) => {
  if (req.user.role !== 'owner' && !req.user.permissions?.includes('view_purchases')) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const { startDate, endDate, staffId, supplierId, productId, status, minCost, maxCost, search, sort } = req.query;
  const { page, limit, skip } = parsePagination(req.query);
  // Cancelled purchases are hidden by default — they're history-preserving
  // corrections, not something staff need cluttering the everyday list.
  const query = { shop: req.user.shop._id, status: { $ne: 'cancelled' } };

  if (status) query.status = status;
  if (staffId) query.staff = staffId;
  if (supplierId) query.supplier = supplierId;
  if (productId) query['items.productId'] = productId;
  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) query.createdAt.$gte = new Date(startDate);
    if (endDate) {
      // Inclusive of the whole selected calendar day — same convention as
      // getSales in saleController.js.
      const endOfDay = new Date(endDate);
      endOfDay.setDate(endOfDay.getDate() + 1);
      query.createdAt.$lt = endOfDay;
    }
  }
  if (minCost != null || maxCost != null) {
    query.grandTotal = {};
    if (minCost != null) query.grandTotal.$gte = minCost;
    if (maxCost != null) query.grandTotal.$lte = maxCost;
  }
  if (search) {
    // supplierName/items.productName are denormalized snapshots on Purchase
    // itself, so (unlike getSales' staff-name search) no $lookup is needed.
    const rx = new RegExp(escapeRegex(search), 'i');
    query.$or = [{ supplierName: rx }, { 'items.productName': rx }];
  }

  const sortMap = {
    newest: { createdAt: -1 },
    oldest: { createdAt: 1 },
    highest_cost: { grandTotal: -1 },
    lowest_cost: { grandTotal: 1 },
  };

  const [purchases, total] = await Promise.all([
    Purchase.find(query)
      .populate('staff', 'name')
      .populate('supplier', 'name')
      .skip(skip)
      .limit(limit)
      .sort(sortMap[sort] || sortMap.newest),
    Purchase.countDocuments(query),
  ]);

  const data = purchases.map(purchase => presentPurchase(purchase, req.user));
  res.json({
    success: true,
    data,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
};

export const getPurchaseById = async (req, res) => {
  if (req.user.role !== 'owner' && !req.user.permissions?.includes('view_purchases')) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const purchase = await Purchase.findOne({ _id: req.params.id, shop: req.user.shop._id })
    .populate('staff', 'name')
    .populate('supplier', 'name phone email location')
    .populate('cancelledBy', 'name');
  if (!purchase) return res.status(404).json({ success: false, message: 'Purchase not found' });

  const data = presentPurchase(purchase, req.user);
  res.json({ success: true, data });
};

/**
 * Edits an existing purchase's items/costs/supplier. Stock is corrected by
 * delta — reverse whatever this purchase previously applied, then re-apply
 * the edited items — rather than attempting a full retroactive recompute of
 * every weighted-average cost change that happened since (out of scope; see
 * the module's design notes on FIFO/weighted-average costing).
 */
export const updatePurchase = async (req, res) => {
  if (req.user.role !== 'owner' && !req.user.permissions?.includes('edit_purchases')) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const shop = req.user.shop._id;
  const existing = await Purchase.findOne({ _id: req.params.id, shop });
  if (!existing) return res.status(404).json({ success: false, message: 'Purchase not found' });
  if (existing.status === 'cancelled') {
    return res.status(400).json({ success: false, message: 'This purchase was cancelled and can no longer be edited.' });
  }

  const { supplierId, supplierName, items, additionalCosts, paymentMethod, purchaseDate } = req.body;
  const session = await mongoose.startSession();

  try {
    let purchase;
    await session.withTransaction(async () => {
      purchase = await Purchase.findOne({ _id: existing._id, shop }).session(session);

      if (!purchase) throw new PurchaseLineError('Purchase not found', 404);
      if (purchase.status === 'cancelled') throw new PurchaseLineError('This purchase was cancelled and can no longer be edited.');

      // Editing a completed purchase reverses and re-applies its stock below —
      // the same stock movement createPurchase gates behind owner approval, so
      // a staffer denied that approval on create can't get it back through edit.
      if (purchase.status === 'completed' && needsOwnerApproval(req.user)) {
        throw new PurchaseLineError('You need update-inventory permission to edit a completed purchase — ask an owner to make this change.', 403);
      }

      if (purchase.inventoryUpdated) {
        await reversePurchaseStock(purchase, session);
      }

      if (supplierId !== undefined) {
        if (supplierId) {
          const supplierDoc = await Supplier.findOne({ _id: supplierId, shop }).session(session);
          if (!supplierDoc) throw new PurchaseLineError('Supplier not found in this shop');
          purchase.supplier = supplierDoc._id;
          purchase.supplierName = supplierDoc.name;
        } else {
          purchase.supplier = undefined;
          purchase.supplierName = supplierName ?? '';
        }
      } else if (supplierName !== undefined) {
        purchase.supplierName = supplierName;
      }

      if (paymentMethod !== undefined) {
        purchase.paymentMethod = paymentMethod;
      }

      if (items) {
        const built = await buildPurchaseItems(items, { shop, session });
        purchase.items = built.items;
        purchase.productsTotal = built.productsTotal;
      }

      if (additionalCosts) {
        const built = buildAdditionalCosts(additionalCosts, req.user._id);
        purchase.additionalCosts = built.additionalCosts;
        purchase.additionalCostsTotal = built.additionalCostsTotal;
      }

      purchase.grandTotal = round2(purchase.productsTotal + purchase.additionalCostsTotal);
      if (purchaseDate) purchase.purchaseDate = purchaseDate;

      if (purchase.status === 'completed') {
        await applyPurchaseReceiptStock(purchase, session);
        purchase.inventoryUpdated = true;
      }

      await purchase.save({ session });
    });

    logAudit({
      shopId: shop, userId: req.user._id, action: 'purchase.updated',
      entityType: 'Purchase', entityId: purchase._id, details: { grandTotal: purchase.grandTotal }, req,
    }).catch(() => {});

    const data = presentPurchase(purchase, req.user);
    res.json({ success: true, data, message: 'Purchase updated.' });
  } catch (error) {
    if (error instanceof PurchaseLineError) return res.status(error.status).json({ success: false, message: error.message });
    throw error;
  } finally {
    await session.endSession();
  }
};

/**
 * Soft-cancels a purchase (status → 'cancelled', record retained for
 * history) and best-effort reverses whatever stock it added.
 */
export const deletePurchase = async (req, res) => {
  if (req.user.role !== 'owner' && !req.user.permissions?.includes('delete_purchases')) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const shop = req.user.shop._id;
  const session = await mongoose.startSession();

  try {
    let purchase;
    await session.withTransaction(async () => {
      purchase = await Purchase.findOne({ _id: req.params.id, shop }).session(session);
      if (!purchase) throw new PurchaseLineError('Purchase not found', 404);
      if (purchase.status === 'cancelled') throw new PurchaseLineError('This purchase has already been cancelled.');

      if (purchase.inventoryUpdated) {
        await reversePurchaseStock(purchase, session);
      }

      purchase.status = 'cancelled';
      purchase.inventoryUpdated = false;
      purchase.cancelledAt = new Date();
      purchase.cancelledBy = req.user._id;
      await purchase.save({ session });
    });

    logAudit({
      shopId: shop, userId: req.user._id, action: 'purchase.cancelled',
      entityType: 'Purchase', entityId: purchase._id, details: {}, req,
    }).catch(() => {});

    res.json({ success: true, data: presentPurchase(purchase, req.user), message: 'Purchase cancelled and stock reversed.' });
  } catch (error) {
    if (error instanceof PurchaseLineError) return res.status(error.status).json({ success: false, message: error.message });
    throw error;
  } finally {
    await session.endSession();
  }
};

/** Owner-only: releases a pending-approval purchase's stock/cost impact. */
export const approvePurchase = async (req, res) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ success: false, message: 'Only the shop owner can approve purchases.' });
  }

  const shop = req.user.shop._id;
  const session = await mongoose.startSession();

  try {
    let purchase;
    await session.withTransaction(async () => {
      purchase = await Purchase.findOne({ _id: req.params.id, shop }).session(session);
      if (!purchase) throw new PurchaseLineError('Purchase not found', 404);
      if (purchase.status !== 'pending_approval') throw new PurchaseLineError('This purchase is not awaiting approval.');

      await applyPurchaseReceiptStock(purchase, session);
      purchase.status = 'completed';
      purchase.inventoryUpdated = true;
      await purchase.save({ session });
    });

    logAudit({
      shopId: shop, userId: req.user._id, action: 'purchase.approved',
      entityType: 'Purchase', entityId: purchase._id, details: {}, req,
    }).catch(() => {});

    res.json({ success: true, data: purchase.toObject(), message: 'Purchase approved — stock updated.' });
  } catch (error) {
    if (error instanceof PurchaseLineError) return res.status(error.status).json({ success: false, message: error.message });
    throw error;
  } finally {
    await session.endSession();
  }
};

export const getPurchaseStatsHandler = async (req, res) => {
  if (req.user.role !== 'owner' && !req.user.permissions?.includes('view_purchases')) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }
  const stats = await getPurchaseStats(req.user.shop._id);
  stats.recentPurchases = stats.recentPurchases.map(purchase => presentPurchase(purchase, req.user));
  if (!canViewPurchasePrices(req.user)) delete stats.totalSpend;
  res.json({ success: true, data: stats });
};

export const getPurchaseAnalyticsHandler = async (req, res) => {
  if (req.user.role !== 'owner' && !req.user.permissions?.includes('view_purchases')) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }
  if (!canViewPurchasePrices(req.user)) return res.status(403).json({ success: false, message: 'You do not have permission to view purchase cost reports.' });
  const { period } = req.query;
  const data = await getPurchaseAnalytics(req.user.shop._id, { period });
  res.json({ success: true, data });
};

import Product from '../models/Product.js';
import InventoryMovement from '../models/InventoryMovement.js';
import { allocateAdditionalCosts, landedUnitCost, round2 } from './purchaseCostAllocation.js';

export class PurchaseLineError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Same-doc cache so a product referenced by more than one line (or a variant
 * on the same product) is mutated and saved exactly once — mirrors
 * saleStockService.js/pricingEngine.js. */
const makeProductCache = (shop, session) => {
  const cache = new Map();
  return async (id) => {
    const key = id.toString();
    if (cache.has(key)) return cache.get(key);
    const doc = await Product.findOne({ _id: id, shop }).session(session);
    if (doc) cache.set(key, doc);
    return doc;
  };
};

/**
 * Rolls a product's (or variant's) running average cost forward by one
 * receipt: newAvgCost = (priorQty·priorCost + qty·unitCost) / (priorQty+qty).
 * Pure and DB-free on purpose — the money math that matters most in this
 * module, kept unit-testable without a database (mirrors shiftService.js's
 * computeShiftSummary).
 */
export const computeWeightedAverageCost = (priorQuantity, priorCost, incomingQuantity, incomingUnitCost) => {
  const newQuantity = round2(priorQuantity + incomingQuantity);
  // A negative priorQuantity (sold before it was ever purchased into the
  // system) carries no real cost basis to blend in — treat it like starting
  // from zero. Otherwise its negative term skews the "average" past both
  // inputs (e.g. -2 units @ 100 + 3 incoming @ 120 would compute to 160).
  if (newQuantity <= 0 || priorQuantity <= 0) return incomingUnitCost;
  return round2((priorQuantity * priorCost + incomingQuantity * incomingUnitCost) / newQuantity);
};

/**
 * Resolves the product/variant a purchase line targets and validates it's
 * something that can actually receive stock. Bundles are virtual (their
 * "stock" is derived from components) and services carry no stock at all, so
 * neither can be purchased directly.
 */
export const resolvePurchaseTarget = (product, item) => {
  const type = product.productType || 'standard';
  if (type === 'bundle' || type === 'service') {
    throw new PurchaseLineError(`${product.name} is a ${type} item and can't be purchased directly.`);
  }
  if (!product.trackInventory) {
    throw new PurchaseLineError(`${product.name} does not track inventory, so it can't be purchased.`);
  }
  if (type === 'configurable') {
    if (!item.variantId) throw new PurchaseLineError(`Select a variant for ${product.name}`);
    const variant = product.variants.id(item.variantId);
    if (!variant) throw new PurchaseLineError(`Variant not found for ${product.name}`);
    return variant;
  }
  return product;
};

/**
 * Increases stock for every line in a purchase and rolls each product's (or
 * variant's) `costPrice` forward as a weighted-average cost:
 *   newAvgCost = (priorQty·priorCost + qty·landedUnitCost) / (priorQty+qty)
 * "Landed" unit cost only differs from the raw recorded unitCost when the
 * purchase's allocationMethod isn't 'none' (see purchaseCostAllocation.js).
 * Writes one InventoryMovement per line as the durable stock-history record.
 * Must run inside the caller's mongoose transaction.
 */
export async function applyPurchaseReceiptStock(purchase, session) {
  const shop = purchase.shop;
  const getProduct = makeProductCache(shop, session);
  const touched = new Set();

  const allocatedExtras = allocateAdditionalCosts(
    purchase.items.map((i) => ({ quantity: i.quantity, totalCost: i.totalCost })),
    purchase.additionalCostsTotal,
    purchase.allocationMethod
  );

  const movements = [];

  for (let i = 0; i < purchase.items.length; i++) {
    const item = purchase.items[i];
    const product = await getProduct(item.productId);
    if (!product) continue; // deleted since the purchase was recorded — best-effort, mirrors restoreSaleStock

    const target = resolvePurchaseTarget(product, item);
    touched.add(product._id.toString());

    const unitCost = landedUnitCost(item, allocatedExtras[i]);
    const priorQuantity = target.quantity;
    const priorCost = target.costPrice;
    const newQuantity = round2(priorQuantity + item.quantity);

    target.quantity = newQuantity;
    target.costPrice = computeWeightedAverageCost(priorQuantity, priorCost, item.quantity, unitCost);

    movements.push({
      shop,
      product: product._id,
      variantId: item.variantId,
      direction: 'in',
      quantity: item.quantity,
      reason: 'purchase',
      refModel: 'Purchase',
      refId: purchase._id,
      quantityBefore: priorQuantity,
      quantityAfter: newQuantity,
      unitCost,
      staff: purchase.staff,
    });
  }

  for (const id of touched) {
    await (await getProduct(id)).save({ session });
  }
  if (movements.length) {
    await InventoryMovement.insertMany(movements, { session });
  }
}

/**
 * Reverses the stock this purchase previously added — used when soft-deleting
 * ("cancelling") a completed purchase. Best-effort and quantity-only per
 * line: plain subtraction, no floor — stock may have already been sold on
 * since this purchase (or have started negative before it), and either way
 * subtracting back out is what correctly restores the prior balance. Skips
 * products/variants deleted since, and deliberately does NOT unwind the
 * weighted-average cost update the receipt made (see plan decision #5 —
 * retroactive recosting is out of scope). Must run inside the caller's
 * mongoose transaction.
 */
export async function reversePurchaseStock(purchase, session) {
  const shop = purchase.shop;
  const getProduct = makeProductCache(shop, session);
  const touched = new Set();
  const movements = [];

  for (const item of purchase.items) {
    const product = await getProduct(item.productId);
    if (!product) continue;

    const type = product.productType || 'standard';
    if (type === 'bundle' || type === 'service' || !product.trackInventory) continue;

    let target;
    if (type === 'configurable') {
      target = item.variantId ? product.variants.id(item.variantId) : null;
      if (!target) continue;
    } else {
      target = product;
    }
    touched.add(product._id.toString());

    const priorQuantity = target.quantity;
    const newQuantity = round2(priorQuantity - item.quantity);
    target.quantity = newQuantity;

    movements.push({
      shop,
      product: product._id,
      variantId: item.variantId,
      direction: 'out',
      quantity: round2(priorQuantity - newQuantity),
      reason: 'purchase_reversed',
      refModel: 'Purchase',
      refId: purchase._id,
      quantityBefore: priorQuantity,
      quantityAfter: newQuantity,
      staff: purchase.staff,
    });
  }

  for (const id of touched) {
    await (await getProduct(id)).save({ session });
  }
  if (movements.length) {
    await InventoryMovement.insertMany(movements, { session });
  }
}

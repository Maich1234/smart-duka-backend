import Product from '../models/Product.js';

export class SaleLineError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const requireWholeQuantity = (quantity, productName) => {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new SaleLineError(`Quantity for ${productName} must be a whole number of at least 1`);
  }
};

/**
 * Landed unit cost at this moment, snapshotted onto the sale line so a later
 * purchase — which rewrites costPrice through weighted-average allocation —
 * can never retroactively change a past period's reported profit.
 *
 * Returns null when the doc carries no usable cost, which propagates to
 * Sale.items[].unitCost and marks the line "cost unknown". 0 is a legitimate
 * cost (services) and is deliberately preserved as 0, not coerced to null.
 */
const unitCostOf = (doc) => (Number.isFinite(doc?.costPrice) ? doc.costPrice : null);

/**
 * Cost of one unit of a bundle: the sum of its components' costs at their
 * per-bundle quantities. Unknown if any single component's cost is unknown —
 * a partial sum would understate COGS and silently overstate profit.
 */
const bundleUnitCost = (components) => {
  let total = 0;
  for (const { doc, quantity } of components) {
    const cost = unitCostOf(doc);
    if (cost === null) return null;
    total += cost * quantity;
  }
  return Math.round(total * 100) / 100;
};

/**
 * Deducts stock unconditionally — a shop is allowed to sell ahead of what's
 * been entered as purchased, so this never blocks the sale. When the
 * deduction takes the product below zero, it's recorded onto
 * `negativeStockAlerts` so the caller can alert the owner once the sale
 * commits (see notifyOwnersNegativeStock in saleController.js).
 */
const checkAndDeductStock = (product, amount, negativeStockAlerts) => {
  if (!product.trackInventory) return;
  const resultingQuantity = product.quantity - amount;
  if (resultingQuantity < 0) {
    negativeStockAlerts.push({ productName: product.name, resultingQuantity });
  }
  product.quantity = resultingQuantity;
};

/**
 * Picks whichever active buyXGetY promotion yields the lowest payable
 * quantity for the given purchase quantity ("best one wins" — promotions
 * don't stack). Returns the discounted subtotal alongside the discount
 * amount and a label for receipts.
 */
const applyPromotions = (promotions, quantity, unitPrice) => {
  const active = (promotions || []).filter((p) => p.isActive !== false && p.buyQty > 0 && p.freeQty > 0);
  let payableQty = quantity;
  let appliedPromotionLabel = null;

  for (const promo of active) {
    const bundleSize = promo.buyQty + promo.freeQty;
    const bundles = Math.floor(quantity / bundleSize);
    if (bundles < 1) continue;
    const candidate = quantity - bundles * promo.freeQty;
    if (candidate < payableQty) {
      payableQty = candidate;
      appliedPromotionLabel = promo.label || `Buy ${promo.buyQty} Get ${promo.freeQty} Free`;
    }
  }

  const subtotal = payableQty * unitPrice;
  return { subtotal, discountAmount: quantity * unitPrice - subtotal, appliedPromotionLabel };
};

/**
 * Resolves which commission config applies to a line: a variant's own config
 * wins when it enables one, otherwise the parent product's. Returns null when
 * neither is configured, which is the common case and keeps the hot path cheap.
 */
const resolveCommissionConfig = (product, variant) => {
  if (variant?.commission?.enabled && variant.commission.basePrice != null) return variant.commission;
  if (product?.commission?.enabled && product.commission.basePrice != null) return product.commission;
  return null;
};

/**
 * Commission earned on one sale line.
 *
 * Computed against the line's *actual realised revenue* (post-promotion
 * subtotal) rather than list price × quantity, so all three of these fall out
 * of one formula instead of needing special cases:
 *   • fixed-price lines  — revenue is sellingPrice × qty, same as before
 *   • negotiated lines   — a `variable`/`service` line sold above the floor
 *                          earns the seller their share of what they actually
 *                          talked the customer up to; that is the whole point
 *                          of the incentive
 *   • promotional lines  — free units are not revenue, so they cannot mint
 *                          commission. A buy-2-get-1 that dips below the
 *                          shop's floor correctly pays nothing rather than
 *                          paying the seller out of the shop's own margin.
 *
 * `basePrice` is a per-unit floor, so the floor for the line is basePrice × qty.
 * Never negative: a line sold below the floor earns 0, it does not claw back.
 */
const commissionFor = (config, { revenue, quantity }) => {
  if (!config) return 0;
  const floor = config.basePrice * quantity;
  const excess = Math.max(0, revenue - floor);
  const sharePercent = config.employeeSharePercent ?? 100;
  return Math.round(excess * (sharePercent / 100) * 100) / 100;
};

/**
 * Fetches (or reuses from productCache) the product doc for a given id,
 * scoped to the shop, within the active session. Used so that the same
 * in-memory document is mutated/saved exactly once even if it's referenced
 * by multiple sale lines (e.g. the same component across two bundles).
 */
const getCachedProduct = async (productId, { shop, session, productCache }) => {
  const key = productId.toString();
  if (productCache.has(key)) return productCache.get(key);
  const product = await Product.findOne({ _id: productId, shop }).session(session);
  if (product) productCache.set(key, product);
  return product;
};

/**
 * Resolves a single cart line into its priced/stock-deducted form. Mutates
 * the relevant product/variant document(s) in place (via productCache) but
 * does not save them — the caller saves every touched doc once after all
 * lines have been resolved.
 *
 * Returns { unitPrice, unitCost, subtotal, quantity, variantId?, variantName?, unitOfMeasure?, productType }
 */
export const resolveSaleLine = async (product, requestedItem, { shop, session, productCache, negativeStockAlerts }) => {
  const quantity = Number(requestedItem.quantity);
  const productType = product.productType || 'standard';

  switch (productType) {
    case 'standard': {
      requireWholeQuantity(quantity, product.name);
      const unitPrice = product.sellingPrice;
      checkAndDeductStock(product, quantity, negativeStockAlerts);
      const { subtotal, discountAmount, appliedPromotionLabel } = applyPromotions(product.promotions, quantity, unitPrice);
      return {
        unitPrice,
        unitCost: unitCostOf(product),
        subtotal,
        discountAmount,
        appliedPromotionLabel,
        quantity,
        productType,
        commissionAmount: commissionFor(resolveCommissionConfig(product), { revenue: subtotal, quantity }),
      };
    }

    case 'variable': {
      requireWholeQuantity(quantity, product.name);
      const unitPrice = requestedItem.unitPrice ?? product.sellingPrice;
      if (!(unitPrice > 0)) {
        throw new SaleLineError(`Price for ${product.name} must be greater than 0`);
      }
      if (product.minPrice != null && unitPrice < product.minPrice) {
        throw new SaleLineError(`Price for ${product.name} cannot be below ${product.minPrice}`);
      }
      if (product.maxPrice != null && unitPrice > product.maxPrice) {
        throw new SaleLineError(`Price for ${product.name} cannot exceed ${product.maxPrice}`);
      }
      checkAndDeductStock(product, quantity, negativeStockAlerts);
      const { subtotal, discountAmount, appliedPromotionLabel } = applyPromotions(product.promotions, quantity, unitPrice);
      return {
        unitPrice,
        unitCost: unitCostOf(product),
        subtotal,
        discountAmount,
        appliedPromotionLabel,
        quantity,
        productType,
        commissionAmount: commissionFor(resolveCommissionConfig(product), { revenue: subtotal, quantity }),
      };
    }

    case 'weighted':
    case 'refillable': {
      if (!(quantity > 0)) {
        throw new SaleLineError(`Quantity for ${product.name} must be greater than 0`);
      }
      const unitPrice = product.sellingPrice;
      checkAndDeductStock(product, quantity, negativeStockAlerts);
      const { subtotal, discountAmount, appliedPromotionLabel } = applyPromotions(product.promotions, quantity, unitPrice);
      return {
        unitPrice,
        unitCost: unitCostOf(product),
        subtotal,
        discountAmount,
        appliedPromotionLabel,
        quantity,
        unitOfMeasure: product.unitOfMeasure,
        productType,
        // Weighted/refillable sell in fractional units (kg, litres), so the
        // floor scales with the measured quantity exactly as it does elsewhere.
        commissionAmount: commissionFor(resolveCommissionConfig(product), { revenue: subtotal, quantity }),
      };
    }

    case 'service': {
      requireWholeQuantity(quantity, product.name);
      const unitPrice = (product.allowPriceOverride && requestedItem.unitPrice != null)
        ? requestedItem.unitPrice
        : product.sellingPrice;
      if (!(unitPrice > 0)) {
        throw new SaleLineError(`Price for ${product.name} must be greater than 0`);
      }
      checkAndDeductStock(product, quantity, negativeStockAlerts);
      const { subtotal, discountAmount, appliedPromotionLabel } = applyPromotions(product.promotions, quantity, unitPrice);
      return {
        unitPrice,
        unitCost: unitCostOf(product),
        subtotal,
        discountAmount,
        appliedPromotionLabel,
        quantity,
        productType,
        commissionAmount: commissionFor(resolveCommissionConfig(product), { revenue: subtotal, quantity }),
      };
    }

    case 'bundle': {
      requireWholeQuantity(quantity, product.name);
      if (!product.bundleItems?.length) {
        throw new SaleLineError(`${product.name} has no bundle items configured`);
      }
      const unitPrice = product.sellingPrice;
      // Cost comes from the components, not the bundle product — components are
      // what stock (and therefore money) actually leaves as.
      const components = [];
      for (const bundleItem of product.bundleItems) {
        const component = await getCachedProduct(bundleItem.product, { shop, session, productCache });
        if (!component) {
          throw new SaleLineError(`A component product in bundle ${product.name} no longer exists`);
        }
        checkAndDeductStock(component, bundleItem.quantity * quantity, negativeStockAlerts);
        components.push({ doc: component, quantity: bundleItem.quantity });
      }
      const subtotal = unitPrice * quantity;
      return {
        unitPrice,
        unitCost: bundleUnitCost(components),
        subtotal,
        quantity,
        productType,
        // Bundles carry no promotions of their own (the bundle *is* the offer),
        // so realised revenue is simply the bundle price times quantity.
        commissionAmount: commissionFor(resolveCommissionConfig(product), { revenue: subtotal, quantity }),
      };
    }

    case 'configurable': {
      requireWholeQuantity(quantity, product.name);
      if (!requestedItem.variantId) {
        throw new SaleLineError(`Select a variant for ${product.name}`);
      }
      const variant = product.variants.id(requestedItem.variantId);
      if (!variant) {
        throw new SaleLineError(`Variant not found for ${product.name}`);
      }
      // Same "never block, just alert" treatment as checkAndDeductStock above.
      const resultingVariantQuantity = variant.quantity - quantity;
      if (resultingVariantQuantity < 0) {
        negativeStockAlerts.push({
          productName: `${product.name} (${variant.name})`,
          resultingQuantity: resultingVariantQuantity,
        });
      }
      variant.quantity = resultingVariantQuantity;
      productCache.set(product._id.toString(), product);

      const subtotal = variant.sellingPrice * quantity;
      return {
        unitPrice: variant.sellingPrice,
        // Variants carry their own costPrice — the parent product's is not a
        // valid substitute (that's the whole point of a configurable product).
        unitCost: unitCostOf(variant),
        subtotal,
        quantity,
        variantId: variant._id,
        variantName: variant.name,
        productType,
        // The variant's own config wins; the parent product's applies to any
        // variant that doesn't set one, so an owner can configure a product
        // once instead of repeating themselves on every size.
        commissionAmount: commissionFor(resolveCommissionConfig(product, variant), { revenue: subtotal, quantity }),
      };
    }

    default:
      throw new SaleLineError(`Unsupported product type: ${productType}`);
  }
};

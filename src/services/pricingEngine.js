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

const checkAndDeductStock = (product, amount) => {
  if (!product.trackInventory) return;
  if (product.quantity < amount) {
    throw new SaleLineError(`Insufficient stock for ${product.name}. Available: ${product.quantity}`);
  }
  product.quantity -= amount;
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
export const resolveSaleLine = async (product, requestedItem, { shop, session, productCache }) => {
  const quantity = Number(requestedItem.quantity);
  const productType = product.productType || 'standard';

  switch (productType) {
    case 'standard': {
      requireWholeQuantity(quantity, product.name);
      const unitPrice = product.sellingPrice;
      checkAndDeductStock(product, quantity);
      const { subtotal, discountAmount, appliedPromotionLabel } = applyPromotions(product.promotions, quantity, unitPrice);
      return { unitPrice, unitCost: unitCostOf(product), subtotal, discountAmount, appliedPromotionLabel, quantity, productType };
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
      checkAndDeductStock(product, quantity);
      const { subtotal, discountAmount, appliedPromotionLabel } = applyPromotions(product.promotions, quantity, unitPrice);
      return { unitPrice, unitCost: unitCostOf(product), subtotal, discountAmount, appliedPromotionLabel, quantity, productType };
    }

    case 'weighted':
    case 'refillable': {
      if (!(quantity > 0)) {
        throw new SaleLineError(`Quantity for ${product.name} must be greater than 0`);
      }
      const unitPrice = product.sellingPrice;
      checkAndDeductStock(product, quantity);
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
      checkAndDeductStock(product, quantity);
      const { subtotal, discountAmount, appliedPromotionLabel } = applyPromotions(product.promotions, quantity, unitPrice);
      return { unitPrice, unitCost: unitCostOf(product), subtotal, discountAmount, appliedPromotionLabel, quantity, productType };
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
        checkAndDeductStock(component, bundleItem.quantity * quantity);
        components.push({ doc: component, quantity: bundleItem.quantity });
      }
      return {
        unitPrice,
        unitCost: bundleUnitCost(components),
        subtotal: unitPrice * quantity,
        quantity,
        productType,
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
      if (variant.quantity < quantity) {
        throw new SaleLineError(`Insufficient stock for ${product.name} (${variant.name}). Available: ${variant.quantity}`);
      }
      variant.quantity -= quantity;
      productCache.set(product._id.toString(), product);

      // Commission is a fixed split of the excess between the variant's
      // listed price and the owner's base price — configurable variants
      // don't support price overrides, so this is fully deterministic.
      let commissionAmount = 0;
      if (variant.commission?.enabled && variant.commission.basePrice != null) {
        const excess = Math.max(0, variant.sellingPrice - variant.commission.basePrice);
        const sharePercent = variant.commission.employeeSharePercent ?? 100;
        commissionAmount = Math.round(excess * (sharePercent / 100) * quantity * 100) / 100;
      }

      return {
        unitPrice: variant.sellingPrice,
        // Variants carry their own costPrice — the parent product's is not a
        // valid substitute (that's the whole point of a configurable product).
        unitCost: unitCostOf(variant),
        subtotal: variant.sellingPrice * quantity,
        quantity,
        variantId: variant._id,
        variantName: variant.name,
        productType,
        commissionAmount,
      };
    }

    default:
      throw new SaleLineError(`Unsupported product type: ${productType}`);
  }
};

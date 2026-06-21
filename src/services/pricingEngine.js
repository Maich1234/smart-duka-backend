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

const checkAndDeductStock = (product, amount) => {
  if (!product.trackInventory) return;
  if (product.quantity < amount) {
    throw new SaleLineError(`Insufficient stock for ${product.name}. Available: ${product.quantity}`);
  }
  product.quantity -= amount;
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
 * Returns { unitPrice, subtotal, quantity, variantId?, variantName?, unitOfMeasure?, productType }
 */
export const resolveSaleLine = async (product, requestedItem, { shop, session, productCache }) => {
  const quantity = Number(requestedItem.quantity);
  const productType = product.productType || 'standard';

  switch (productType) {
    case 'standard': {
      requireWholeQuantity(quantity, product.name);
      const unitPrice = product.sellingPrice;
      checkAndDeductStock(product, quantity);
      return { unitPrice, subtotal: unitPrice * quantity, quantity, productType };
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
      return { unitPrice, subtotal: unitPrice * quantity, quantity, productType };
    }

    case 'weighted':
    case 'refillable': {
      if (!(quantity > 0)) {
        throw new SaleLineError(`Quantity for ${product.name} must be greater than 0`);
      }
      const unitPrice = product.sellingPrice;
      checkAndDeductStock(product, quantity);
      return {
        unitPrice,
        subtotal: unitPrice * quantity,
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
      return { unitPrice, subtotal: unitPrice * quantity, quantity, productType };
    }

    case 'bundle': {
      requireWholeQuantity(quantity, product.name);
      if (!product.bundleItems?.length) {
        throw new SaleLineError(`${product.name} has no bundle items configured`);
      }
      const unitPrice = product.sellingPrice;
      for (const bundleItem of product.bundleItems) {
        const component = await getCachedProduct(bundleItem.product, { shop, session, productCache });
        if (!component) {
          throw new SaleLineError(`A component product in bundle ${product.name} no longer exists`);
        }
        checkAndDeductStock(component, bundleItem.quantity * quantity);
      }
      return { unitPrice, subtotal: unitPrice * quantity, quantity, productType };
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
      return {
        unitPrice: variant.sellingPrice,
        subtotal: variant.sellingPrice * quantity,
        quantity,
        variantId: variant._id,
        variantName: variant.name,
        productType,
      };
    }

    default:
      throw new SaleLineError(`Unsupported product type: ${productType}`);
  }
};

import Product from '../models/Product.js';

/**
 * Puts back the stock a sale deducted — shared by sale voiding, cash refunds,
 * and the M-Pesa reversal result callback. Mirrors pricingEngine's deduction
 * paths. Best-effort per line: products/variants deleted since the sale are
 * skipped rather than blocking the correction (the money record matters most).
 *
 * Must run inside the caller's mongoose session/transaction.
 */
export async function restoreSaleStock(sale, session) {
  const shop = sale.shop;
  // Same-doc cache as createSale so a product referenced by several lines
  // (e.g. shared bundle components) is mutated and saved exactly once.
  const productCache = new Map();
  const getProduct = async (id) => {
    const key = id.toString();
    if (productCache.has(key)) return productCache.get(key);
    const doc = await Product.findOne({ _id: id, shop }).session(session);
    if (doc) productCache.set(key, doc);
    return doc;
  };

  for (const item of sale.items) {
    const product = await getProduct(item.productId);
    if (!product) continue; // deleted since the sale — nothing to restore

    const type = item.productType || product.productType || 'standard';
    if (type === 'configurable') {
      const variant = item.variantId ? product.variants.id(item.variantId) : null;
      if (variant) variant.quantity += item.quantity;
    } else if (type === 'bundle') {
      // Restore components per the bundle's *current* recipe — the sale
      // snapshot doesn't record component quantities.
      for (const bundleItem of product.bundleItems || []) {
        const component = await getProduct(bundleItem.product);
        if (component?.trackInventory) {
          component.quantity += bundleItem.quantity * item.quantity;
        }
      }
    } else if (product.trackInventory) {
      product.quantity += item.quantity;
    }
  }

  for (const doc of productCache.values()) {
    await doc.save({ session });
  }
}

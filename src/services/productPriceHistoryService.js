import ProductPriceChange from '../models/ProductPriceChange.js';

const states = product => {
  if (!product) return new Map();
  const p = product.toObject ? product.toObject() : product;
  const rows = new Map([['base', { sellingPrice: p.sellingPrice, costPrice: p.costPrice, minPrice: p.minPrice ?? null, maxPrice: p.maxPrice ?? null, productType: p.productType ?? 'standard', allowPriceOverride: p.allowPriceOverride ?? false, bundleItems: (p.bundleItems ?? []).map(b => ({ product: String(b.product), quantity: b.quantity })) }]]);
  for (const v of p.variants ?? []) rows.set(String(v._id), { name: v.name, sellingPrice: v.sellingPrice, costPrice: v.costPrice });
  return rows;
};

/** Must share the product write's transaction: history failure rolls back the edit. */
export function buildProductPriceChange({ before, after, actor, source, reference }) {
  const old = states(before), current = states(after);
  const changes = [...new Set([...old.keys(), ...current.keys()])].flatMap(key => {
    const from = old.get(key) ?? null, to = current.get(key) ?? null;
    const comparable = value => value ? JSON.stringify({ ...value, name: undefined }) : 'null';
    return comparable(from) === comparable(to) ? [] : [{ key, before: from, after: to }];
  });
  if (!changes.length) return;
  return {
    shop: after.shop, product: after._id, productName: after.name,
    actor: actor?._id ?? actor, actorName: actor?.name ?? null, source, reference, changes,
  };
}

export async function recordProductPriceChange(options) {
  const document = buildProductPriceChange(options);
  if (document) await ProductPriceChange.create([document], { session: options.session });
}

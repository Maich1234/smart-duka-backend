const norm = value => String(value ?? '').trim().toLowerCase();
export function duplicateErrors(products, existing) {
  const maps = { name: new Map(), sku: new Map(), barcode: new Map() }, errors = [];
  const add = (key, value, who, incoming) => {
    const id = norm(value); if (!id) return;
    if (maps[key].has(id) && incoming) { if (errors.length < 2000) errors.push(`${String(who).slice(0, 160)}: ${key} "${String(value).slice(0, 160)}" is already used by ${String(maps[key].get(id)).slice(0, 160)}.`); }
    else maps[key].set(id, who);
  };
  for (const [incoming, list] of [[false, existing], [true, products]]) for (const p of list) {
    add('name', p.name, p.name, incoming);
    for (const row of [p, ...(p.variants ?? [])]) for (const key of ['sku', 'barcode']) add(key, row[key], p.name, incoming);
  }
  return errors;
}

/** Read only possible collisions for single-product edits, rather than the full catalogue. */
export async function findDuplicateCandidates(product, shop, session, excludeId) {
  const Product = (await import('../models/Product.js')).default;
  const regex = value => new RegExp(`^${String(value).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  const conditions = [{ name: regex(product.name) }];
  for (const key of ['sku', 'barcode']) {
    const values = [product, ...(product.variants ?? [])].map(row => row[key]).filter(value => String(value ?? '').trim()).map(regex);
    if (values.length) conditions.push({ [key]: { $in: values } }, { [`variants.${key}`]: { $in: values } });
  }
  return Product.find({ shop, ...(excludeId ? { _id: { $ne: excludeId } } : {}), $or: conditions }).select('name sku barcode variants').limit(20).session(session).lean();
}

import Shop from '../models/Shop.js';
/** Serialize catalogue writes per shop so import duplicate checks cannot race edits. */
export async function lockCatalogue(shop, session) {
  const result = await Shop.collection.updateOne({ _id: shop }, { $inc: { catalogueRevision: 1 } }, { session });
  if (!result.matchedCount) throw Object.assign(new Error('Shop not found.'), { status: 404 });
}

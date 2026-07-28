/**
 * Reconstructs cost of goods on sale lines recorded before Sale.items[].unitCost
 * existed.
 *
 *   node scripts/backfillSaleCosts.mjs              # dry run — reports, writes nothing
 *   node scripts/backfillSaleCosts.mjs --apply      # writes
 *   node scripts/backfillSaleCosts.mjs --apply --shop <shopId>
 *
 * Dry-run by default, matching syncIndexes.mjs: this rewrites historical
 * financial figures, so writing takes an explicit flag.
 *
 * What it can and cannot know
 * ---------------------------
 * The cost it writes is the product's cost *today*, not the cost when the sale
 * happened — that number is gone, which is the entire reason unitCost now
 * exists. Purchasing advances costPrice as a weighted average on every landed-
 * cost allocation (purchaseStockService.computeWeightedAverageCost), so for any
 * product bought since the sale, today's cost is wrong by some unknowable
 * amount.
 *
 * Every line written here is therefore marked `costEstimated: true`. That flag
 * is load-bearing: without it a reconstructed cost is indistinguishable from a
 * captured one and every historical period would silently render as exact.
 *
 * Backfilling is still preferable to leaving the field null. A shop with six
 * months of history in the app experiences "no books before August" as the app
 * having lost their records; a labelled estimate is honest and usable. Books
 * that never read cost — Cashbook, the registers, Inventory Valuation, Stock
 * Movement — are exact for these periods either way.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import Sale from '../src/models/Sale.js';
import Product from '../src/models/Product.js';

const apply = process.argv.includes('--apply');
const shopArgIndex = process.argv.indexOf('--shop');
const shopFilter = shopArgIndex !== -1 ? process.argv[shopArgIndex + 1] : null;

const BATCH_SIZE = 500;
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Cost of one unit of `item` using today's product data. Returns null when it
 * cannot be established — a null stays null rather than becoming a guess of a
 * guess, so the reader still falls back to a live lookup.
 */
const reconstructUnitCost = (item, product) => {
  if (!product) return null;

  if (item.variantId) {
    const variant = product.variants?.find((v) => String(v._id) === String(item.variantId));
    return Number.isFinite(variant?.costPrice) ? variant.costPrice : null;
  }

  // Bundles cost what their components cost. bundleItems may have been edited
  // since the sale, which makes this the roughest estimate of the set — but a
  // bundle's own costPrice is not a substitute, since components are what
  // actually left the shelf.
  if (product.productType === 'bundle') {
    if (!product.bundleItems?.length) return null;
    let total = 0;
    for (const bundleItem of product.bundleItems) {
      const component = bundleItem.product;
      if (!Number.isFinite(component?.costPrice)) return null;
      total += component.costPrice * bundleItem.quantity;
    }
    return round2(total);
  }

  return Number.isFinite(product.costPrice) ? product.costPrice : null;
};

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set');
  await mongoose.connect(process.env.MONGO_URI);

  const match = { 'items.unitCost': null };
  if (shopFilter) match.shop = new mongoose.Types.ObjectId(shopFilter);

  const total = await Sale.countDocuments(match);
  console.log(`${total} sale(s) with un-costed lines${shopFilter ? ` in shop ${shopFilter}` : ''}.`);
  if (!total) return;
  if (!apply) console.log('DRY RUN — pass --apply to write.\n');

  let scanned = 0;
  let salesTouched = 0;
  let linesFilled = 0;
  let linesUnresolved = 0;
  let ops = [];

  const cursor = Sale.find(match).select('items').batchSize(BATCH_SIZE).cursor();

  for await (const sale of cursor) {
    scanned += 1;

    const productIds = [...new Set(
      sale.items.filter((i) => i.unitCost == null).map((i) => String(i.productId)),
    )];
    // populate() resolves bundle components in one hop so reconstructUnitCost
    // can read component.costPrice directly.
    const products = await Product.find({ _id: { $in: productIds } })
      .select('productType costPrice variants bundleItems')
      .populate('bundleItems.product', 'costPrice')
      .lean();
    const byId = new Map(products.map((p) => [String(p._id), p]));

    const set = {};
    let filledInThisSale = 0;

    sale.items.forEach((item, index) => {
      if (item.unitCost != null) return;
      const unitCost = reconstructUnitCost(item, byId.get(String(item.productId)));
      if (unitCost === null) {
        linesUnresolved += 1;
        return;
      }
      set[`items.${index}.unitCost`] = unitCost;
      set[`items.${index}.costTotal`] = round2(unitCost * item.quantity);
      set[`items.${index}.costEstimated`] = true;
      filledInThisSale += 1;
    });

    if (!filledInThisSale) continue;
    linesFilled += filledInThisSale;
    salesTouched += 1;
    // Field-path $set, never a whole-document save: a sale is an immutable
    // financial record and this must not touch totals, status, or refund state.
    ops.push({ updateOne: { filter: { _id: sale._id }, update: { $set: set } } });

    if (apply && ops.length >= BATCH_SIZE) {
      await Sale.bulkWrite(ops, { ordered: false });
      ops = [];
      console.log(`  ${scanned}/${total} scanned…`);
    }
  }

  if (apply && ops.length) await Sale.bulkWrite(ops, { ordered: false });

  console.log(`\n${apply ? 'Done' : 'Dry run complete'}.`);
  console.log(`  sales scanned:      ${scanned}`);
  console.log(`  sales ${apply ? 'updated' : 'to update'}:   ${salesTouched}`);
  console.log(`  lines ${apply ? 'filled' : 'fillable'}:    ${linesFilled} (marked costEstimated)`);
  if (linesUnresolved) {
    console.log(`  lines unresolved:   ${linesUnresolved} (product or cost missing — left null)`);
  }
}

main()
  .catch((err) => {
    console.error('Failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());

/**
 * Migrates invoice numbering from a global counter to a per-shop one.
 *
 * Background: Sale.invoiceNumber carried a collection-wide unique index while
 * the number itself was generated from countDocuments({ shop }) — a per-shop
 * count. Every shop's first sale of a month therefore wanted INV-YYMM-00001,
 * and only the first shop to write it could have it; every other shop's sale
 * failed with a duplicate key error. The count also raced against itself, so
 * two concurrent sales in one shop could read the same value.
 *
 * This script makes an existing database consistent with the fixed models:
 *
 *   1. Seeds Shop.invoiceSeq so the next issued number continues past whatever
 *      the shop has already used.
 *   2. Creates the { shop, invoiceNumber } unique index.
 *   3. Drops the old invoiceNumber_1 index.
 *
 * That order is deliberate — the new index exists before the old one goes, so
 * there is never a window without uniqueness protection.
 *
 * Safe to re-run: seeding takes the max of what is already there, and both
 * index operations tolerate having been done before.
 *
 *   node scripts/fixInvoiceNumbering.mjs           # apply
 *   node scripts/fixInvoiceNumbering.mjs --dry-run # report only, change nothing
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import Shop from '../src/models/Shop.js';
import Sale from '../src/models/Sale.js';

const dryRun = process.argv.includes('--dry-run');

/** Pulls the numeric tail out of "INV-2608-00042" → 42. Null if unparseable. */
const parseSeq = (invoiceNumber) => {
  const match = /^INV-\d{4}-(\d+)$/.exec(invoiceNumber ?? '');
  return match ? Number.parseInt(match[1], 10) : null;
};

async function seedCounters() {
  const shops = await Shop.find({}).select('_id name invoiceSeq').lean();
  console.log(`Seeding invoiceSeq for ${shops.length} shop(s)...\n`);

  let changed = 0;

  for (const shop of shops) {
    // The highest number this shop has actually issued. Sales predating the
    // INV- format (or with the field unset) parse to null and are ignored here.
    const sales = await Sale.find({ shop: shop._id }).select('invoiceNumber').lean();
    const maxIssued = sales.reduce((max, s) => {
      const seq = parseSeq(s.invoiceNumber);
      return seq !== null && seq > max ? seq : max;
    }, 0);

    // Floor at the raw sale count: if some sales have unparseable numbers, the
    // old scheme still consumed a slot for each, so the count is the safer
    // lower bound. Taking the max of both can only ever skip forward, which
    // leaves a gap — harmless — rather than reissuing a number, which is not.
    const target = Math.max(maxIssued, sales.length, shop.invoiceSeq ?? 0);

    if (target === (shop.invoiceSeq ?? 0)) continue;

    console.log(
      `  ${shop.name}: invoiceSeq ${shop.invoiceSeq ?? 0} -> ${target}` +
      ` (${sales.length} sale(s), highest issued ${maxIssued || 'none'})`,
    );

    if (!dryRun) {
      await Shop.updateOne({ _id: shop._id }, { $set: { invoiceSeq: target } });
    }
    changed += 1;
  }

  console.log(`\n${changed} shop(s) ${dryRun ? 'would be' : ''} updated.\n`);
}

async function fixIndexes() {
  const collection = mongoose.connection.collection('sales');
  const existing = await collection.indexes();
  const names = existing.map((i) => i.name);

  console.log(`Existing sales indexes: ${names.join(', ')}\n`);

  if (names.includes('shop_1_invoiceNumber_1')) {
    console.log('  { shop, invoiceNumber } unique index already present.');
  } else if (dryRun) {
    console.log('  would create { shop, invoiceNumber } unique index');
  } else {
    await collection.createIndex({ shop: 1, invoiceNumber: 1 }, { unique: true });
    console.log('  created { shop, invoiceNumber } unique index');
  }

  if (!names.includes('invoiceNumber_1')) {
    console.log('  old invoiceNumber_1 index already gone.');
  } else if (dryRun) {
    console.log('  would drop old invoiceNumber_1 index');
  } else {
    await collection.dropIndex('invoiceNumber_1');
    console.log('  dropped old invoiceNumber_1 index');
  }
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set');

  // This script manages the sales indexes explicitly; autoIndex would race it.
  mongoose.set('autoIndex', false);
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected.${dryRun ? ' DRY RUN — nothing will be written.' : ''}\n`);

  await seedCounters();
  await fixIndexes();

  console.log('\nDone.');
}

main()
  .catch((error) => {
    console.error('\nFailed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());

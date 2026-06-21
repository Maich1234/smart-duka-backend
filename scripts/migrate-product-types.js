// One-time backfill: sets productType: 'standard' (and trackInventory: true,
// unitOfMeasure: 'unit') on every existing product document. Mongoose schema
// defaults apply on document hydration, but NOT inside aggregation
// $match/$group on raw BSON — this keeps future analytics aggregations
// (depletion, pricing-type breakdowns) correct without relying on hydration.
//
// Safe to run multiple times (only touches docs missing the field).
// Usage: node scripts/migrate-product-types.js
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import connectDB from '../src/config/db.js';
import Product from '../src/models/Product.js';

dotenv.config();

const run = async () => {
  await connectDB();

  const result = await Product.updateMany(
    { productType: { $exists: false } },
    {
      $set: {
        productType: 'standard',
        trackInventory: true,
        unitOfMeasure: 'unit',
      },
    }
  );

  console.log(`Backfilled ${result.modifiedCount} product(s) with productType: 'standard'`);
  await mongoose.disconnect();
};

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});

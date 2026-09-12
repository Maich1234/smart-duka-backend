import mongoose from 'mongoose';
import Product from '../models/Product.js';

/**
 * The one definition of "what is the stock on the shelves worth".
 *
 * Extracted because it was wrong in the only place it existed. The previous
 * expression (in dailySummaryService) was `quantity × costPrice` on the
 * product document — but a `configurable` product never holds stock there:
 * pricingEngine deducts from `variants[].quantity` and purchasing tops up the
 * same field, leaving the parent's `quantity` at its default 0 forever. A
 * shop selling by variant (sizes, flavours) therefore reported a stock value
 * of zero no matter how full the shelves were.
 *
 * Two other product types need care for the opposite reason — double
 * counting. A `bundle` owns no stock of its own (its components do, and they
 * are separate products), and a product with `trackInventory: false` (a
 * service) has none at all; any quantity sitting on either is not stock.
 */

/** quantity × <field> at the product level. */
const topLevelValue = (field) => ({
  $multiply: [{ $ifNull: ['$quantity', 0] }, { $ifNull: [`$${field}`, 0] }],
});

/** Σ (quantity × <field>) across the product's variants. */
const variantValue = (field) => ({
  $sum: {
    $map: {
      input: { $ifNull: ['$variants', []] },
      as: 'v',
      in: {
        $multiply: [
          { $ifNull: ['$$v.quantity', 0] },
          { $ifNull: [`$$v.${field}`, 0] },
        ],
      },
    },
  },
});

/** Value of one product's stock on hand, at `costPrice` or `sellingPrice`. */
export const stockValueExpression = (field) => ({
  $switch: {
    branches: [
      { case: { $eq: ['$productType', 'configurable'] }, then: variantValue(field) },
      // No stock of its own — see the note above.
      { case: { $eq: ['$productType', 'bundle'] }, then: 0 },
      { case: { $eq: ['$trackInventory', false] }, then: 0 },
    ],
    default: topLevelValue(field),
  },
});

/**
 * `$group` stage rolling a shop's products up into its stock position.
 * Exported as stages (not a function) so callers can drop it into an existing
 * `Promise.all` of aggregations without a second round trip.
 *
 * `potentialSalesValue` is what the same stock would bring in at today's
 * selling prices — presented separately, never mixed into the cost figure,
 * because the money the owner has actually tied up is the cost one.
 */
export const inventoryValuationStages = [
  {
    $group: {
      _id: null,
      stockAtCost: { $sum: stockValueExpression('costPrice') },
      potentialSalesValue: { $sum: stockValueExpression('sellingPrice') },
      productCount: { $sum: 1 },
    },
  },
];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Normalizes a raw `inventoryValuationStages` result into the shape clients read. */
export const shapeValuation = (row) => {
  const stockAtCost = round2(row?.stockAtCost);
  const potentialSalesValue = round2(row?.potentialSalesValue);
  return {
    stockAtCost,
    potentialSalesValue,
    potentialMargin: round2(potentialSalesValue - stockAtCost),
    productCount: row?.productCount ?? 0,
  };
};

/** Stock position for one shop. */
export async function getInventoryValuation(shopId) {
  const shop = new mongoose.Types.ObjectId(String(shopId));
  const [row] = await Product.aggregate([{ $match: { shop } }, ...inventoryValuationStages]);
  return shapeValuation(row);
}

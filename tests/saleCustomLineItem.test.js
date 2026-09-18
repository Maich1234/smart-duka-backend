import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Sale from '../src/models/Sale.js';

test('allows a sale item with no productId (a custom/service line)', async () => {
  const sale = new Sale({
    shop: new mongoose.Types.ObjectId(),
    items: [{ productName: 'Custom labor', quantity: 1, unitPrice: 500, subtotal: 500 }],
    totalAmount: 500,
    paymentMethod: 'cash',
    staff: new mongoose.Types.ObjectId(),
  });
  await assert.doesNotReject(() => sale.validate());
});

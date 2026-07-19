import mongoose from 'mongoose';

// First-class stock ledger. Currently only written by the Purchasing module
// (see purchaseStockService.js) — Sale/void/refund stock changes are NOT
// retrofitted to emit these yet; that flow is already tested and working via
// bare `product.quantity +=` mutations, and rewiring it is a deliberate,
// separate follow-up rather than something bundled into this feature.
const inventoryMovementSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true,
    index: true,
  },
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
  },
  variantId: {
    type: mongoose.Schema.Types.ObjectId,
  },
  direction: {
    type: String,
    enum: ['in', 'out'],
    required: true,
  },
  quantity: {
    type: Number,
    required: true,
    min: 0,
  },
  reason: {
    type: String,
    enum: ['purchase', 'purchase_reversed', 'sale', 'sale_void', 'refund', 'manual_adjustment'],
    required: true,
  },
  // Polymorphic reference to whatever caused this movement (a Purchase today).
  refModel: {
    type: String,
    enum: ['Purchase', 'Sale'],
  },
  refId: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: 'refModel',
  },
  quantityBefore: { type: Number },
  quantityAfter: { type: Number },
  // Landed unit cost at the moment of the movement — only meaningful for
  // 'purchase' — kept here (not just on Purchase) so a future FIFO costing
  // engine can walk movements directly without joining back to Purchase.
  unitCost: { type: Number },
  staff: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
}, {
  timestamps: true,
});

// Hot path: "stock history for this product" list, newest first.
inventoryMovementSchema.index({ shop: 1, product: 1, createdAt: -1 });

export default mongoose.model('InventoryMovement', inventoryMovementSchema);

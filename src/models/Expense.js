import mongoose from 'mongoose';

const EXPENSE_CATEGORIES = ['rent', 'utilities', 'supplies', 'transport', 'salaries', 'marketing', 'other'];

const expenseSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true,
    index: true,
  },
  category: {
    type: String,
    enum: EXPENSE_CATEGORIES,
    required: [true, 'Category is required'],
  },
  amount: {
    type: Number,
    required: [true, 'Amount is required'],
    min: 0,
  },
  description: {
    type: String,
    trim: true,
  },
  date: {
    type: Date,
    default: Date.now,
  },
  recordedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  // Work session this expense was recorded in — cash expenses paid from the
  // till reduce the drawer's expected cash at shift close.
  shift: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shift',
  },
}, {
  timestamps: true,
});

expenseSchema.index({ shop: 1, date: -1 });

export const EXPENSE_CATEGORY_VALUES = EXPENSE_CATEGORIES;
export default mongoose.model('Expense', expenseSchema);

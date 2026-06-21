import Expense from '../models/Expense.js';

export const getExpenses = async (req, res) => {
  if (req.user.role !== 'owner' && !req.user.permissions?.includes('manage_expenses')) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const { category, startDate, endDate, page = 1, limit = 20 } = req.query;
  const query = { shop: req.user.shop._id };

  if (category) {
    query.category = category;
  }

  if (startDate || endDate) {
    query.date = {};
    if (startDate) query.date.$gte = new Date(startDate);
    if (endDate) query.date.$lte = new Date(endDate);
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const expenses = await Expense.find(query).skip(skip).limit(parseInt(limit)).sort({ date: -1 });
  const total = await Expense.countDocuments(query);

  res.json({
    success: true,
    data: expenses,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / parseInt(limit)),
    },
  });
};

export const getExpenseSummary = async (req, res) => {
  if (req.user.role !== 'owner' && !req.user.permissions?.includes('manage_expenses')) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const { startDate, endDate } = req.query;
  const query = { shop: req.user.shop._id };

  if (startDate || endDate) {
    query.date = {};
    if (startDate) query.date.$gte = new Date(startDate);
    if (endDate) query.date.$lte = new Date(endDate);
  }

  const expenses = await Expense.find(query).select('category amount');
  const total = expenses.reduce((sum, e) => sum + e.amount, 0);

  const byCategory = new Map();
  for (const e of expenses) {
    byCategory.set(e.category, (byCategory.get(e.category) || 0) + e.amount);
  }

  res.json({
    success: true,
    data: {
      total,
      byCategory: Array.from(byCategory.entries()).map(([category, amount]) => ({ category, amount })),
    },
  });
};

export const createExpense = async (req, res) => {
  if (req.user.role !== 'owner' && !req.user.permissions?.includes('manage_expenses')) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const expense = await Expense.create({ ...req.body, shop: req.user.shop._id, recordedBy: req.user._id });
  res.status(201).json({ success: true, data: expense });
};

export const updateExpense = async (req, res) => {
  if (req.user.role !== 'owner' && !req.user.permissions?.includes('manage_expenses')) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const expense = await Expense.findOne({ _id: req.params.id, shop: req.user.shop._id });
  if (!expense) {
    return res.status(404).json({ success: false, message: 'Expense not found' });
  }

  const updatedExpense = await Expense.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  res.json({ success: true, data: updatedExpense });
};

export const deleteExpense = async (req, res) => {
  if (req.user.role !== 'owner' && !req.user.permissions?.includes('manage_expenses')) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const expense = await Expense.findOne({ _id: req.params.id, shop: req.user.shop._id });
  if (!expense) {
    return res.status(404).json({ success: false, message: 'Expense not found' });
  }

  await expense.deleteOne();
  res.json({ success: true, message: 'Expense deleted successfully' });
};

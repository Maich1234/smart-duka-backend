import Expense from '../models/Expense.js';
import { getActiveShift } from '../services/shiftService.js';
import { parsePagination } from '../utils/pagination.js';
import { getExpenseSummaryData } from '../services/expenseSummaryService.js';

export const getExpenses = async (req, res) => {
  if (req.user.role !== 'owner' && !req.user.permissions?.includes('manage_expenses')) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const { category, startDate, endDate } = req.query;
  const { page, limit, skip } = parsePagination(req.query);
  const query = { shop: req.user.shop._id };

  if (category) {
    query.category = category;
  }

  if (startDate || endDate) {
    query.date = {};
    if (startDate) query.date.$gte = new Date(startDate);
    if (endDate) query.date.$lte = new Date(endDate);
  }

  const [expenses, total] = await Promise.all([
    Expense.find(query).skip(skip).limit(limit).sort({ date: -1 }),
    Expense.countDocuments(query),
  ]);

  res.json({
    success: true,
    data: expenses,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
};

export const getExpenseSummary = async (req, res) => {
  if (req.user.role !== 'owner' && !req.user.permissions?.includes('manage_expenses')) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const { startDate, endDate } = req.query;
  const summary = await getExpenseSummaryData(req.user.shop._id, { startDate, endDate });

  res.json({ success: true, data: summary });
};

export const createExpense = async (req, res) => {
  if (req.user.role !== 'owner' && !req.user.permissions?.includes('manage_expenses')) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  // Expenses recorded mid-shift come out of the till, so link them to the
  // session — shift close subtracts them from expected cash.
  const activeShift = req.user.shop?.shiftManagementEnabled
    ? await getActiveShift(req.user._id)
    : null;

  const expense = await Expense.create({
    ...req.body,
    shop: req.user.shop._id,
    recordedBy: req.user._id,
    ...(activeShift ? { shift: activeShift._id } : {}),
  });
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

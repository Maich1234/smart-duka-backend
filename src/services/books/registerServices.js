import Sale from '../../models/Sale.js';
import Expense from '../../models/Expense.js';
import Purchase from '../../models/Purchase.js';
import { buildBookDocument, money, periodBounds } from './bookDocument.js';

/**
 * The three plain registers: every sale, every expense, every purchase, in
 * the period, as recorded.
 *
 * Unlike the Cashbook and P&L these compute almost nothing — the value is in
 * being complete and exportable. Voided and refunded rows stay visible (an
 * accountant needs to see them) but are excluded from totals, which is the
 * same rule the daily summary uses.
 */

const STATUS_LABEL = {
  completed: '',
  voided: 'Voided',
  refund_pending: 'Refund pending',
  refunded: 'Refunded',
};

/** Excluded from totals, still printed. */
const isNonRevenue = (status) => status === 'voided' || status === 'refunded';

export async function buildSalesRegister({ shop, ownerName, from, to }) {
  const { start, end } = periodBounds(from, to);

  const sales = await Sale.find({ shop: shop._id, createdAt: { $gte: start, $lte: end } })
    .select('invoiceNumber totalAmount paymentMethod paymentMethodLabel createdAt status items staff')
    .populate('staff', 'name')
    .sort({ createdAt: 1 })
    .lean();

  let total = 0;
  let counted = 0;
  const rows = sales.map((sale) => {
    const excluded = isNonRevenue(sale.status);
    if (!excluded) {
      total = money(total + sale.totalAmount);
      counted += 1;
    }
    const itemCount = (sale.items ?? []).reduce((n, i) => n + (i.quantity || 0), 0);
    return {
      date: sale.createdAt,
      invoice: sale.invoiceNumber ?? '',
      staff: sale.staff?.name ?? '',
      items: itemCount,
      method: sale.paymentMethodLabel || sale.paymentMethod || '',
      status: STATUS_LABEL[sale.status] ?? sale.status,
      // Blanked rather than zeroed: the sale had a value, it just doesn't
      // count. A zero would read as a free sale.
      amount: excluded ? '' : money(sale.totalAmount),
    };
  });

  return buildBookDocument({
    key: 'sales_register',
    title: 'Sales Register',
    shop,
    ownerName,
    from,
    to,
    columns: [
      { key: 'date', label: 'Date', align: 'left', type: 'date' },
      { key: 'invoice', label: 'Invoice', align: 'left', type: 'text' },
      { key: 'staff', label: 'Served by', align: 'left', type: 'text' },
      { key: 'items', label: 'Items', align: 'right', type: 'number' },
      { key: 'method', label: 'Paid by', align: 'left', type: 'text' },
      { key: 'status', label: 'Status', align: 'left', type: 'text' },
      { key: 'amount', label: 'Amount', align: 'right', type: 'money' },
    ],
    sections: [{ rows }],
    totals: { amount: total, sales: counted },
    footnotes: [
      'Voided and refunded sales are listed but excluded from the total.',
      'Sales awaiting an M-Pesa reversal still count — the money has not gone back yet.',
    ],
  });
}

const EXPENSE_LABELS = {
  rent: 'Rent', utilities: 'Utilities', supplies: 'Supplies', transport: 'Transport',
  salaries: 'Salaries & wages', marketing: 'Marketing', other: 'Other',
};

export async function buildExpenseRegister({ shop, ownerName, from, to }) {
  const { start, end } = periodBounds(from, to);

  const expenses = await Expense.find({ shop: shop._id, date: { $gte: start, $lte: end } })
    .select('category description amount paymentMethod date recordedBy')
    .populate('recordedBy', 'name')
    .sort({ date: 1 })
    .lean();

  // Grouped by category, since "where is the money going" is the question an
  // expense register is opened to answer.
  const byCategory = new Map();
  for (const e of expenses) {
    if (!byCategory.has(e.category)) byCategory.set(e.category, []);
    byCategory.get(e.category).push(e);
  }

  const sections = [...byCategory.entries()]
    .map(([category, items]) => {
      const subtotal = money(items.reduce((s, i) => s + i.amount, 0));
      return {
        label: `${EXPENSE_LABELS[category] ?? category} — ${items.length} item${items.length === 1 ? '' : 's'}`,
        subtotalValue: subtotal,
        rows: items.map((e) => ({
          date: e.date,
          description: e.description || EXPENSE_LABELS[e.category] || e.category,
          method: e.paymentMethod || 'cash',
          recordedBy: e.recordedBy?.name ?? '',
          amount: money(e.amount),
        })),
        subtotals: { amount: subtotal },
      };
    })
    .sort((a, b) => b.subtotalValue - a.subtotalValue)
    .map(({ subtotalValue, ...section }) => section);

  const total = money(expenses.reduce((s, e) => s + e.amount, 0));

  return buildBookDocument({
    key: 'expense_register',
    title: 'Expense Register',
    shop,
    ownerName,
    from,
    to,
    columns: [
      { key: 'date', label: 'Date', align: 'left', type: 'date' },
      { key: 'description', label: 'Description', align: 'left', type: 'text' },
      { key: 'method', label: 'Paid by', align: 'left', type: 'text' },
      { key: 'recordedBy', label: 'Recorded by', align: 'left', type: 'text' },
      { key: 'amount', label: 'Amount', align: 'right', type: 'money' },
    ],
    sections,
    totals: { amount: total, expenses: expenses.length },
    footnotes: ['Grouped by category, largest first.'],
  });
}

export async function buildPurchaseRegister({ shop, ownerName, from, to }) {
  const { start, end } = periodBounds(from, to);

  const purchases = await Purchase.find({ shop: shop._id, purchaseDate: { $gte: start, $lte: end } })
    .select('supplierName items productsTotal additionalCostsTotal grandTotal paymentMethod purchaseDate status')
    .sort({ purchaseDate: 1 })
    .lean();

  let total = 0;
  let counted = 0;
  const rows = purchases.map((p) => {
    const excluded = p.status === 'cancelled';
    if (!excluded) {
      total = money(total + (p.grandTotal || 0));
      counted += 1;
    }
    return {
      date: p.purchaseDate,
      supplier: p.supplierName || 'No supplier',
      items: (p.items ?? []).length,
      products: money(p.productsTotal),
      extraCosts: money(p.additionalCostsTotal),
      method: p.paymentMethod || 'cash',
      status: p.status === 'completed' ? '' : p.status.replace(/_/g, ' '),
      amount: excluded ? '' : money(p.grandTotal),
    };
  });

  return buildBookDocument({
    key: 'purchase_register',
    title: 'Purchase Register',
    shop,
    ownerName,
    from,
    to,
    columns: [
      { key: 'date', label: 'Date', align: 'left', type: 'date' },
      { key: 'supplier', label: 'Supplier', align: 'left', type: 'text' },
      { key: 'items', label: 'Lines', align: 'right', type: 'number' },
      { key: 'products', label: 'Products', align: 'right', type: 'money' },
      { key: 'extraCosts', label: 'Extra costs', align: 'right', type: 'money' },
      { key: 'method', label: 'Paid by', align: 'left', type: 'text' },
      { key: 'status', label: 'Status', align: 'left', type: 'text' },
      { key: 'amount', label: 'Total', align: 'right', type: 'money' },
    ],
    sections: [{ rows }],
    totals: { amount: total, purchases: counted },
    footnotes: [
      'Cancelled purchases are listed but excluded from the total.',
      'Purchases still awaiting owner approval are included — the stock was ordered even if it has not been released into inventory.',
      'Extra costs are transport, loading, market fees and similar, as recorded against each purchase.',
    ],
  });
}

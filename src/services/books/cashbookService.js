import Sale from '../../models/Sale.js';
import Expense from '../../models/Expense.js';
import Purchase from '../../models/Purchase.js';
import { buildBookDocument, money, periodBounds } from './bookDocument.js';

/**
 * The Cashbook — chronological money in and money out with a running balance,
 * split by the pot it moved through.
 *
 * Two rules decide what appears here, and both matter:
 *
 * 1. **Only movements where money actually moved.** A purchase taken on
 *    credit is a real liability but no cash left the shop, so it is excluded
 *    (it is the seed of a future Creditors book). Same for a sale still
 *    awaiting an M-Pesa reversal — the money is still with the shop.
 * 2. **Voided sales never happened.** They are excluded outright rather than
 *    shown and subtracted, because a void means the sale was recorded in
 *    error, not that it was reversed.
 *
 * A completed refund appears as its own money-out row on the date it was
 * completed, not as an adjustment to the original sale's row. That keeps the
 * running balance honest on the day the cash actually left the drawer, which
 * is what someone reconciling a till against this book needs.
 */

/** Which pot a movement went through. Anything unrecognised is grouped as Other. */
const POTS = ['cash', 'mpesa', 'bank', 'other'];

const potOf = (method) => {
  const m = String(method || 'cash').toLowerCase();
  if (m === 'cash') return 'cash';
  if (m === 'mpesa' || m === 'airtel_money') return 'mpesa';
  if (m === 'bank' || m === 'cheque') return 'bank';
  return 'other';
};

const COLUMNS = [
  { key: 'date', label: 'Date', align: 'left', type: 'date' },
  { key: 'reference', label: 'Reference', align: 'left', type: 'text' },
  { key: 'description', label: 'Description', align: 'left', type: 'text' },
  { key: 'pot', label: 'Paid via', align: 'left', type: 'text' },
  { key: 'moneyIn', label: 'Money in', align: 'right', type: 'money' },
  { key: 'moneyOut', label: 'Money out', align: 'right', type: 'money' },
  { key: 'balance', label: 'Running balance', align: 'right', type: 'money' },
];

const POT_LABEL = { cash: 'Cash', mpesa: 'M-Pesa', bank: 'Bank', other: 'Other' };

export async function buildCashbook({ shop, ownerName, from, to }) {
  const { start, end } = periodBounds(from, to);
  const shopId = shop._id;

  const [sales, expenses, purchases] = await Promise.all([
    // 'refund_pending' is included: the money is still with the shop until
    // Safaricom completes the reversal, and excluding it would understate
    // the drawer on the day of the sale.
    Sale.find({
      shop: shopId,
      status: { $in: ['completed', 'refund_pending', 'refunded'] },
      createdAt: { $gte: start, $lte: end },
    })
      .select('invoiceNumber totalAmount paymentMethod paymentMethodLabel createdAt status refund')
      .sort({ createdAt: 1 })
      .lean(),
    Expense.find({ shop: shopId, date: { $gte: start, $lte: end } })
      .select('category description amount paymentMethod date')
      .sort({ date: 1 })
      .lean(),
    // Credit purchases are deliberately absent: no cash moved.
    Purchase.find({
      shop: shopId,
      status: { $ne: 'cancelled' },
      paymentMethod: { $ne: 'credit' },
      purchaseDate: { $gte: start, $lte: end },
    })
      .select('supplierName grandTotal paymentMethod purchaseDate status')
      .sort({ purchaseDate: 1 })
      .lean(),
  ]);

  const movements = [];

  for (const sale of sales) {
    // A sale that was later fully refunded still brought money in on its own
    // day; the refund below takes it out again on the day it completed.
    movements.push({
      at: sale.createdAt,
      reference: sale.invoiceNumber ? `Sale ${sale.invoiceNumber}` : 'Sale',
      description: 'Sale',
      pot: potOf(sale.paymentMethod),
      potLabel: sale.paymentMethodLabel || POT_LABEL[potOf(sale.paymentMethod)],
      in: money(sale.totalAmount),
      out: 0,
    });

    if (sale.status === 'refunded' && sale.refund?.completedAt) {
      const at = new Date(sale.refund.completedAt);
      // Only if the refund landed inside this period — a June sale refunded
      // in July belongs to July's book, not June's.
      if (at >= start && at <= end) {
        movements.push({
          at,
          reference: sale.invoiceNumber ? `Refund ${sale.invoiceNumber}` : 'Refund',
          description: sale.refund.reason || 'Refund to customer',
          pot: potOf(sale.refund.method),
          potLabel: POT_LABEL[potOf(sale.refund.method)],
          in: 0,
          out: money(sale.refund.amount ?? sale.totalAmount),
        });
      }
    }
  }

  for (const expense of expenses) {
    movements.push({
      at: expense.date,
      reference: `Expense · ${expense.category}`,
      description: expense.description || expense.category,
      pot: potOf(expense.paymentMethod),
      potLabel: POT_LABEL[potOf(expense.paymentMethod)],
      in: 0,
      out: money(expense.amount),
    });
  }

  for (const purchase of purchases) {
    movements.push({
      at: purchase.purchaseDate,
      reference: 'Purchase',
      description: purchase.supplierName || 'Stock purchase',
      pot: potOf(purchase.paymentMethod),
      potLabel: POT_LABEL[potOf(purchase.paymentMethod)],
      in: 0,
      out: money(purchase.grandTotal),
    });
  }

  movements.sort((a, b) => new Date(a.at) - new Date(b.at));

  const byPot = Object.fromEntries(POTS.map((p) => [p, { in: 0, out: 0 }]));
  let balance = 0;
  const rows = movements.map((m) => {
    balance = money(balance + m.in - m.out);
    byPot[m.pot].in = money(byPot[m.pot].in + m.in);
    byPot[m.pot].out = money(byPot[m.pot].out + m.out);
    return {
      date: m.at,
      reference: m.reference,
      description: m.description,
      pot: m.potLabel,
      moneyIn: m.in || '',
      moneyOut: m.out || '',
      balance,
    };
  });

  const totalIn = money(movements.reduce((s, m) => s + m.in, 0));
  const totalOut = money(movements.reduce((s, m) => s + m.out, 0));

  const footnotes = [
    'Opening balance is taken as zero — this book shows movement within the period, not the shop’s total cash position.',
    'Purchases recorded as being on credit are excluded: the stock arrived but no money has left yet.',
    'Sales cancelled with a void are excluded entirely. Refunds appear as their own row on the day the money went back.',
  ];

  // Per-pot closing figures — what someone counting a drawer or checking an
  // M-Pesa statement actually reconciles against. One row per pot, in the
  // same columns, so every renderer draws it without special-casing.
  const usedPots = POTS.filter((p) => byPot[p].in > 0 || byPot[p].out > 0);
  const potSection = usedPots.length > 1
    ? [{
        label: 'By payment method',
        rows: usedPots.map((p) => ({
          date: '',
          reference: POT_LABEL[p],
          description: '',
          pot: '',
          moneyIn: byPot[p].in || '',
          moneyOut: byPot[p].out || '',
          balance: money(byPot[p].in - byPot[p].out),
        })),
        subtotals: { moneyIn: totalIn, moneyOut: totalOut, balance: money(totalIn - totalOut) },
      }]
    : [];

  return buildBookDocument({
    key: 'cashbook',
    title: 'Cashbook',
    shop,
    ownerName,
    from,
    to,
    columns: COLUMNS,
    sections: [{ rows }, ...potSection],
    totals: { moneyIn: totalIn, moneyOut: totalOut, balance: money(totalIn - totalOut) },
    footnotes,
  });
}

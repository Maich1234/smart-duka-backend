import { buildCashbook } from './cashbookService.js';
import { buildProfitLoss } from './profitLossService.js';
import {
  buildSalesRegister,
  buildExpenseRegister,
  buildPurchaseRegister,
} from './registerServices.js';

/**
 * Every book the shop can generate, in the order it should be offered.
 *
 * Ordered by usefulness to a duka owner rather than accounting convention —
 * Cashbook and P&L first, registers after. `requiresFlag` hides a book whose
 * module the shop hasn't switched on, so a shop not using Purchasing is never
 * offered an empty Purchase Register.
 */
export const BOOKS = [
  {
    key: 'cashbook',
    title: 'Cashbook',
    description: 'Money in and out with a running balance, split by cash, M-Pesa and bank.',
    build: buildCashbook,
  },
  {
    key: 'profit_loss',
    title: 'Simplified Profit & Loss',
    description: 'Revenue, cost of goods sold, gross profit, expenses and net profit.',
    build: buildProfitLoss,
  },
  {
    key: 'sales_register',
    title: 'Sales Register',
    description: 'Every sale in the period, with voided and refunded ones marked.',
    build: buildSalesRegister,
  },
  {
    key: 'expense_register',
    title: 'Expense Register',
    description: 'Every expense, grouped by category.',
    build: buildExpenseRegister,
  },
  {
    key: 'purchase_register',
    title: 'Purchase Register',
    description: 'Every stock purchase, with supplier and landed costs.',
    build: buildPurchaseRegister,
    requiresFlag: 'purchasingEnabled',
  },
];

export const bookByKey = (key) => BOOKS.find((b) => b.key === key) ?? null;

/** The books a given shop can actually generate, given its enabled modules. */
export const availableBooks = (shop) =>
  BOOKS.filter((b) => !b.requiresFlag || shop?.[b.requiresFlag] === true);

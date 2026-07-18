import { Type } from '@google/genai';

/**
 * FunctionDeclaration[] passed to Gemini as `tools`. Every parameter here is
 * deliberately shop-agnostic — no declaration exposes a shop/shopId field,
 * so there is no code path by which the model's `args` can influence tenant
 * scoping (see toolExecutors.js, which always injects shopId server-side).
 */
export const TOOL_DECLARATIONS = [
  {
    name: 'get_business_snapshot',
    description:
      "Full current snapshot: today's revenue/profit/expenses/transactions, 7-day and 30-day trend, inventory fast/slow movers and stock value, TODAY's per-staff performance, payment-method breakdown, 0-100 health score, active alerts, rule-based insights. Default first call for broad 'how's my business doing' questions. Staff performance here is TODAY only — use get_staff_performance for any range.",
    parameters: { type: Type.OBJECT, properties: {}, required: [] },
  },
  {
    name: 'get_daily_summary',
    description:
      'Detailed breakdown for ONE calendar day: revenue, transactions, discounts, gross profit, expenses, payment-method split, best/slow sellers, per-staff performance that day, shift cash reconciliation, M-Pesa reconciliation. Use for a specific past date, not "today" in general.',
    parameters: {
      type: Type.OBJECT,
      properties: { date: { type: Type.STRING, description: 'YYYY-MM-DD, defaults to today.' } },
      required: [],
    },
  },
  {
    name: 'get_sales_trend',
    description:
      'Revenue trend as buckets: daily (last 7 days), weekly (last 8 weeks), or monthly (last 6 months) — total/cash/mpesa revenue and transaction count per bucket. Use for trend/period-over-period questions.',
    parameters: {
      type: Type.OBJECT,
      properties: { period: { type: Type.STRING, enum: ['daily', 'weekly', 'monthly'], description: 'Defaults to daily.' } },
      required: [],
    },
  },
  {
    name: 'get_peak_hours',
    description:
      "Transaction count and revenue by hour-of-day (0-23, Africa/Nairobi local time) and by day-of-week, over a trailing window (default 30 days). Includes precomputed busiestHour/busiestWeekday — always report those directly, never scan the hours/weekdays arrays yourself. Use for 'when is it busiest' or staffing-timing questions.",
    parameters: {
      type: Type.OBJECT,
      properties: { windowDays: { type: Type.INTEGER, description: '1-90, defaults to 30.' } },
      required: [],
    },
  },
  {
    name: 'get_depletion_analytics',
    description:
      'Per-product sales velocity and stockout risk over a trailing window (default 30 days): fast/slow/dead movers, and products projected to run out soon with days remaining. Use for restocking questions.',
    parameters: {
      type: Type.OBJECT,
      properties: { windowDays: { type: Type.INTEGER, description: '1-90, defaults to 30.' } },
      required: [],
    },
  },
  {
    name: 'detect_sales_anomaly',
    description:
      "Compares today's running sales to the trailing 14-day average (z-score). Returns direction and percent difference if today is a statistical outlier, or that nothing unusual is happening yet.",
    parameters: { type: Type.OBJECT, properties: {}, required: [] },
  },
  {
    name: 'get_staff_performance',
    description:
      'Per-staff sales count, revenue, and commission over a date range (defaults to trailing 30 days). Use for any staff-performance question spanning more than one day.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        startDate: { type: Type.STRING, description: 'YYYY-MM-DD' },
        endDate: { type: Type.STRING, description: 'YYYY-MM-DD' },
      },
      required: [],
    },
  },
  {
    name: 'get_expense_summary',
    description:
      'Total expenses and breakdown by category (rent/utilities/supplies/transport/salaries/marketing/other) over a date range (defaults to all-time).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        startDate: { type: Type.STRING, description: 'YYYY-MM-DD' },
        endDate: { type: Type.STRING, description: 'YYYY-MM-DD' },
      },
      required: [],
    },
  },
];

/**
 * Customer credit ("deni") — the shop-level rules and the pure helpers that
 * turn them into a decision.
 *
 * Deliberately free of Mongoose imports so every rule here is directly unit
 * testable, the same way productVisibility.js keeps its authorization logic
 * out of the controller.
 */

/** The till button that means "the customer is taking this on account". */
export const CREDIT_METHOD_KEY = 'credit';

/** Ledger entry kinds. A correction is always a new row, never an edit. */
export const CREDIT_TX_TYPES = {
  SALE: 'CREDIT_SALE',
  PAYMENT: 'CREDIT_PAYMENT',
  SALE_REVERSAL: 'CREDIT_SALE_REVERSAL',
  PAYMENT_REVERSAL: 'CREDIT_PAYMENT_REVERSAL',
  // A debt that already existed before this shop started tracking credit here
  // — brought forward by the owner, not created by a sale in this system.
  // Ages and collects exactly like a CREDIT_SALE; kept as its own type so a
  // statement never claims the shop sold something it didn't.
  OPENING_BALANCE: 'CREDIT_OPENING_BALANCE',
};

/**
 * Which direction each entry moves the customer's outstanding balance.
 * `amount` is always stored positive — the type carries the sign, so a
 * malformed negative amount can never quietly become a credit.
 */
export const CREDIT_TX_SIGN = {
  [CREDIT_TX_TYPES.SALE]: 1,
  [CREDIT_TX_TYPES.PAYMENT]: -1,
  [CREDIT_TX_TYPES.SALE_REVERSAL]: -1,
  [CREDIT_TX_TYPES.PAYMENT_REVERSAL]: 1,
  [CREDIT_TX_TYPES.OPENING_BALANCE]: 1,
};

/**
 * The entry kinds that *are* a debt — they carry their own `outstanding`,
 * `dueAt` and `status`, age into overdue, and receive repayment allocations.
 * Everything else moves the balance without being collectable in its own right.
 */
export const DEBT_TX_TYPES = [CREDIT_TX_TYPES.SALE, CREDIT_TX_TYPES.OPENING_BALANCE];

/** Which products may be sold on credit. */
export const CREDIT_PRODUCT_POLICIES = ['ALL_PRODUCTS', 'SELECTED_PRODUCTS'];

/** What happens when a customer already has a debt past its due date. */
export const CREDIT_OVERDUE_POLICIES = ['BLOCK', 'ALLOW'];

/**
 * Collection periods offered in the picker, in days. 0 is "immediate" —
 * due at the end of the day the sale is made, which is how a duka actually
 * talks about lunchtime credit ("lete jioni").
 *
 * The list is presentation only: any integer in [0, MAX_COLLECTION_PERIOD_DAYS]
 * is accepted so "custom" needs no separate storage shape.
 */
export const COLLECTION_PERIOD_PRESETS = [0, 3, 7, 14, 30];
export const MAX_COLLECTION_PERIOD_DAYS = 365;

/** Nothing sane needs a bigger per-customer ceiling, and it caps overflow abuse. */
export const MAX_CREDIT_LIMIT = 10_000_000;
/** One credit sale or repayment can never legitimately exceed this. */
export const MAX_CREDIT_AMOUNT = 10_000_000;

/**
 * Money is stored as a plain Number here, matching Sale.totalAmount and every
 * other figure in this codebase. Two decimals is the resolution of a shilling
 * amount, so comparisons get a half-cent of slack: without it a repayment of
 * exactly the outstanding balance can be rejected by float drift accumulated
 * over a dozen part-payments.
 */
export const MONEY_EPSILON = 0.005;

/** Rounds to cents. Every figure written to the ledger passes through here. */
export const money = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

export const DEFAULT_CREDIT_SETTINGS = {
  enabled: false,
  defaultCreditLimit: 0,
  defaultCollectionPeriodDays: 7,
  productPolicy: 'ALL_PRODUCTS',
  overduePolicy: 'BLOCK',
};

/**
 * A shop's credit settings with the defaults standing in for anything absent.
 *
 * Same reasoning as resolvePaymentMethods: `.lean()` reads skip schema
 * defaults, and every shop that predates this feature has no subdocument at
 * all, so no call site may read `shop.creditSettings.enabled` directly.
 */
export const resolveCreditSettings = (shop) => {
  const stored = shop?.creditSettings;
  const plain = stored && typeof stored.toObject === 'function' ? stored.toObject() : stored;
  return { ...DEFAULT_CREDIT_SETTINGS, ...(plain ?? {}) };
};

export const isCreditEnabled = (shop) => resolveCreditSettings(shop).enabled === true;

/**
 * The ceiling this particular customer may owe.
 *
 * A per-customer limit of `null` means "follow the shop" — stored as null
 * rather than copying the shop default in, so raising the shop-wide limit
 * lifts every customer who was never given a bespoke one.
 *
 * Read-side only: the authoritative check happens in the database, where the
 * same fallback is expressed as `$ifNull` so a limit edited mid-transaction
 * still wins. See creditService.
 */
export const effectiveCreditLimit = (customer, settings) =>
  customer?.credit?.limit ?? settings.defaultCreditLimit ?? 0;

/**
 * When a credit sale made at `from` falls due.
 *
 * Always end-of-day in the server's timezone: a debt taken at 09:00 on a
 * 3-day term is due at the close of the third day, not at 09:00, because
 * nobody in a shop counts a due date by the hour. Stored on the transaction
 * so a later change to the shop's collection period never moves a debt that
 * already exists.
 */
export const computeDueAt = (from, collectionPeriodDays) => {
  const due = new Date(from);
  due.setDate(due.getDate() + Math.max(0, Math.trunc(collectionPeriodDays ?? 0)));
  due.setHours(23, 59, 59, 999);
  return due;
};

/** Whole days a debt has been past due, floored at 0. */
export const daysOverdue = (dueAt, now = new Date()) => {
  if (!dueAt) return 0;
  const diff = now.getTime() - new Date(dueAt).getTime();
  return diff <= 0 ? 0 : Math.floor(diff / 86_400_000);
};

/** Human label for a stored collection period, used in settings and receipts. */
export const collectionPeriodLabel = (days) => {
  const n = Math.max(0, Math.trunc(days ?? 0));
  if (n === 0) return 'Due same day';
  if (n === 1) return 'Due in 1 day';
  if (n === 7) return 'Due in 1 week';
  if (n === 14) return 'Due in 2 weeks';
  if (n === 30) return 'Due in 1 month';
  return `Due in ${n} days`;
};

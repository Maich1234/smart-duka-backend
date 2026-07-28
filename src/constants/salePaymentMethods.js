/**
 * How money came *in* — the buttons a cashier sees at the till.
 *
 * Unlike MONEY_OUT_METHODS (a fixed list, because the Cashbook needs stable
 * columns for expenses and purchases), money-in is shop-defined. Kenyan shops
 * take payment in ways no fixed enum survives: Pochi la Biashara, Send Money to
 * a personal number, a Till, a Paybill, Airtel Money, a bank account, or an
 * informal arrangement with a regular customer. Forcing them into
 * 'cash' | 'mpesa' | 'card' meant a shop that takes Airtel had to lie.
 *
 * So a Shop carries its own ordered list of methods and the till renders it.
 * Only two keys carry behaviour:
 *
 *   'cash'  — counted as physical drawer money in shift reconciliation.
 *   'mpesa' — offers STK Push *when* the shop has connected M-Pesa Business.
 *             Without credentials it still records and prints like any other
 *             method; plenty of shops take M-Pesa on a Pochi or personal
 *             number, where Safaricom offers no STK API at all.
 *
 * Every other key is a label on a button. Recording the sale and printing the
 * receipt is the whole behaviour, which is exactly what a shop needs before
 * anyone integrates anything.
 */

/** Reserved keys whose behaviour is special-cased. Cannot be renamed away. */
export const CASH_METHOD_KEY = 'cash';
export const MPESA_METHOD_KEY = 'mpesa';

/**
 * Keys that older aggregations always reported. Kept present (as zeroes) in
 * every byMethod payload so existing clients reading `byMethod.card.total`
 * don't start seeing `undefined` after this change.
 */
export const LEGACY_METHOD_KEYS = ['cash', 'mpesa', 'card'];

/** Custom keys are slugs — safe in Mongo field paths and in query strings. */
export const METHOD_KEY_PATTERN = /^[a-z0-9][a-z0-9_]{1,23}$/;

/**
 * What a shop starts with. M-Pesa is on by default and deliberately not gated
 * on credentials — an unconfigured shop taps it and sells, same as cash.
 */
export const DEFAULT_PAYMENT_METHODS = [
  { key: 'cash', label: 'Cash', icon: 'cash', enabled: true },
  { key: 'mpesa', label: 'M-PESA', icon: 'phone', enabled: true },
];

/**
 * Ready-made buttons offered in the manager UI, so an owner adding Airtel
 * Money doesn't have to invent a key or spell the label.
 */
export const SUGGESTED_PAYMENT_METHODS = [
  { key: 'airtel_money', label: 'Airtel Money', icon: 'phone' },
  { key: 'bank', label: 'Bank Transfer', icon: 'bank' },
  { key: 'card', label: 'Card', icon: 'card' },
  { key: 'cheque', label: 'Cheque', icon: 'bank' },
  { key: 'credit', label: 'Credit (Deni)', icon: 'clock' },
  { key: 'voucher', label: 'Voucher', icon: 'tag' },
];

/** Icon names the clients know how to draw. Unknown values fall back to 'wallet'. */
export const METHOD_ICONS = ['cash', 'phone', 'bank', 'card', 'clock', 'tag', 'wallet'];

/**
 * A shop's methods, with the defaults standing in when the field is missing.
 *
 * Shops created before this feature have no `paymentMethods` array, and
 * `.lean()` reads bypass Mongoose's schema defaults entirely — so every call
 * site resolves through here rather than trusting the raw document.
 */
export const resolvePaymentMethods = (shop) => {
  const stored = shop?.paymentMethods;
  const list = Array.isArray(stored) && stored.length > 0
    ? stored.map((m) => (typeof m.toObject === 'function' ? m.toObject() : m))
    : DEFAULT_PAYMENT_METHODS.map((m) => ({ ...m }));
  return list.map((m, i) => ({ ...m, order: m.order ?? i }))
    .sort((a, b) => a.order - b.order);
};

/** Just the keys a sale is allowed to be recorded against. */
export const enabledMethodKeys = (shop) =>
  resolvePaymentMethods(shop).filter((m) => m.enabled !== false).map((m) => m.key);

/** Display label for a key, for receipts and history. */
export const methodLabel = (shop, key) =>
  resolvePaymentMethods(shop).find((m) => m.key === key)?.label
  ?? key?.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  ?? '';

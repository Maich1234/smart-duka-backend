/**
 * The normalized shape every book service returns, and every renderer
 * consumes. See docs/business-books.md §3.1 in the mobile repo.
 *
 * The point is that N books × M formats does not mean N×M renderers. A book
 * service does pure aggregation and knows nothing about CSV, Excel or PDF;
 * a renderer knows nothing about cashbooks. Adding a book costs one service
 * and zero renderers.
 *
 * @typedef {'text'|'money'|'number'|'date'} ColumnType
 *
 * @typedef {object} BookColumn
 * @property {string} key
 * @property {string} label
 * @property {'left'|'right'} align
 * @property {ColumnType} type
 *
 * @typedef {object} BookSection
 * @property {string} [label]              Group heading, e.g. an expense category.
 * @property {Record<string, any>[]} rows
 * @property {Record<string, number>} [subtotals]
 *
 * @typedef {object} BookDocument
 * @property {string} key
 * @property {string} title
 * @property {{ name: string, currency: string, ownerName: string }} shop
 * @property {{ from: string, to: string, label: string }} period
 * @property {BookColumn[]} columns
 * @property {BookSection[]} sections
 * @property {Record<string, number>} totals
 * @property {string[]} footnotes
 * @property {{ documentId: string, token: string, verifyUrl: string }} stamp
 * @property {{ generatedAt: string, estimated: boolean, version: number }} meta
 */

import { signBookStamp, bookVerifyUrl } from '../../utils/bookStamp.js';

/** Bumped when a book's columns or figures change meaning, so old exports are identifiable. */
export const BOOK_FORMAT_VERSION = 1;

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * A human label for a period: "July 2026" for a whole month, "2026" for a
 * whole year, otherwise "1 Jul – 15 Jul 2026". Printed on every book, so an
 * exported file is self-describing once it's off the screen.
 */
export function periodLabel(from, to) {
  const f = new Date(from);
  const t = new Date(to);
  const sameYear = f.getUTCFullYear() === t.getUTCFullYear();
  const sameMonth = sameYear && f.getUTCMonth() === t.getUTCMonth();

  const isMonthStart = f.getUTCDate() === 1;
  const lastOfMonth = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  const isMonthEnd = t.getUTCDate() === lastOfMonth;

  if (sameMonth && isMonthStart && isMonthEnd) {
    return `${MONTHS[f.getUTCMonth()]} ${f.getUTCFullYear()}`;
  }
  if (sameYear && isMonthStart && isMonthEnd && f.getUTCMonth() === 0 && t.getUTCMonth() === 11) {
    return String(f.getUTCFullYear());
  }
  const d = (x) => `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()].slice(0, 3)}`;
  return sameYear
    ? `${d(f)} – ${d(t)} ${t.getUTCFullYear()}`
    : `${d(f)} ${f.getUTCFullYear()} – ${d(t)} ${t.getUTCFullYear()}`;
}

/** Rounds to cents. Float sums drift, and these figures go to a bank. */
export const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Assembles a BookDocument, filling in the parts every book shares so a
 * service only supplies what makes it that book.
 */
export function buildBookDocument({
  key,
  title,
  shop,
  ownerName,
  from,
  to,
  columns,
  sections,
  totals = {},
  footnotes = [],
  estimated = false,
}) {
  const generatedAt = new Date().toISOString();
  const period = {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    label: periodLabel(from, to),
  };

  // Signed over the totals as well as the identity, so a figure edited in a
  // PDF editor no longer agrees with the document's own stamp.
  const { token, documentId } = signBookStamp({
    shopId: shop?._id,
    shopName: shop?.name ?? 'Shop',
    key,
    title,
    from: period.from,
    to: period.to,
    generatedAt,
    totals,
  });

  return {
    key,
    title,
    shop: {
      name: shop?.name ?? 'Shop',
      currency: shop?.currency ?? 'KES',
      ownerName: ownerName ?? '',
    },
    period,
    columns,
    sections,
    totals,
    footnotes,
    stamp: {
      documentId,
      token,
      verifyUrl: bookVerifyUrl(token),
    },
    meta: {
      generatedAt,
      estimated,
      version: BOOK_FORMAT_VERSION,
    },
  };
}

/**
 * Inclusive day bounds in UTC. A shop's "1–31 July" must not silently become
 * 30.96 days because the request carried a timezone offset.
 */
export function periodBounds(from, to) {
  const start = new Date(from);
  const end = new Date(to);
  start.setUTCHours(0, 0, 0, 0);
  end.setUTCHours(23, 59, 59, 999);
  return { start, end };
}

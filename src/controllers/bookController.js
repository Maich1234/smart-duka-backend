import { availableBooks, bookByKey } from '../services/books/registry.js';
import { renderCsv } from '../services/books/renderers/csv.js';
import { renderXlsx } from '../services/books/renderers/xlsx.js';
import { renderPdf } from '../services/books/renderers/pdf.js';

/**
 * Business books — the shop's financial records, computed server-side.
 *
 * Server-side is deliberate (docs/business-books.md §3.1): a financial
 * statement is a document, not a view. Computing it on a client would let two
 * clients disagree about figures a shopkeeper may take to a lender.
 *
 * Generation is stateless — nothing is persisted. The catalogue plus a
 * generate-and-stream pair covers viewing and downloading; a GeneratedBook
 * archive is only needed for offline re-download, which is a mobile concern.
 */

const FORMATS = {
  csv: { ext: 'csv', mime: 'text/csv; charset=utf-8', render: renderCsv },
  xlsx: {
    ext: 'xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    render: renderXlsx,
  },
  pdf: { ext: 'pdf', mime: 'application/pdf', render: renderPdf },
};

/** Widest period we'll aggregate in one request, to bound a serverless call. */
const MAX_PERIOD_DAYS = 400;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolves and sanity-checks the requested period. Defaults to the current
 * calendar month, which is what an owner opening this page almost always
 * wants.
 */
function resolvePeriod(query) {
  const now = new Date();
  const defaultFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const defaultTo = now;

  const from = query.from ? new Date(query.from) : defaultFrom;
  const to = query.to ? new Date(query.to) : defaultTo;

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return { error: 'Provide valid from and to dates.' };
  }
  if (from > to) {
    return { error: 'The start date must come before the end date.' };
  }
  if ((to - from) / DAY_MS > MAX_PERIOD_DAYS) {
    return { error: `Choose a period of ${MAX_PERIOD_DAYS} days or less.` };
  }
  return { from, to };
}

/** Safe for a Content-Disposition filename on any platform. */
const slug = (value) =>
  String(value || 'shop')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'shop';

/** GET /reports/books — what this shop can generate. */
export const listBooks = async (req, res) => {
  const shop = req.user.shop;
  res.json({
    success: true,
    data: {
      books: availableBooks(shop).map(({ key, title, description }) => ({ key, title, description })),
      formats: Object.keys(FORMATS),
      currency: shop?.currency ?? 'KES',
      maxPeriodDays: MAX_PERIOD_DAYS,
    },
  });
};

/**
 * GET /reports/books/:key — the book as JSON, for on-screen viewing.
 * Same computation the download uses, so what's on screen is what downloads.
 */
export const getBook = async (req, res) => {
  const book = bookByKey(req.params.key);
  if (!book) {
    return res.status(404).json({ success: false, message: 'Unknown book.' });
  }

  const shop = req.user.shop;
  if (book.requiresFlag && shop?.[book.requiresFlag] !== true) {
    return res.status(400).json({
      success: false,
      message: `${book.title} needs that module switched on for this shop.`,
    });
  }

  const period = resolvePeriod(req.query);
  if (period.error) {
    return res.status(400).json({ success: false, message: period.error });
  }

  const doc = await book.build({
    shop,
    ownerName: req.user.name,
    from: period.from,
    to: period.to,
  });

  res.json({ success: true, data: doc });
};

/** GET /reports/books/:key/download?format=csv|xlsx|pdf */
export const downloadBook = async (req, res) => {
  const book = bookByKey(req.params.key);
  if (!book) {
    return res.status(404).json({ success: false, message: 'Unknown book.' });
  }

  const format = FORMATS[String(req.query.format || 'pdf').toLowerCase()];
  if (!format) {
    return res.status(400).json({
      success: false,
      message: `Choose one of: ${Object.keys(FORMATS).join(', ')}.`,
    });
  }

  const shop = req.user.shop;
  if (book.requiresFlag && shop?.[book.requiresFlag] !== true) {
    return res.status(400).json({
      success: false,
      message: `${book.title} needs that module switched on for this shop.`,
    });
  }

  const period = resolvePeriod(req.query);
  if (period.error) {
    return res.status(400).json({ success: false, message: period.error });
  }

  const doc = await book.build({
    shop,
    ownerName: req.user.name,
    from: period.from,
    to: period.to,
  });

  const body = await format.render(doc);
  const filename = `${slug(shop?.name)}-${book.key.replace(/_/g, '-')}-${slug(doc.period.label)}.${format.ext}`;

  res.setHeader('Content-Type', format.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // These carry a shop's finances; no shared cache should ever hold one.
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.send(Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'));
};

/**
 * Per-shop invoice numbering.
 *
 * Split out of Sale's pre-save hook so the sequencing rules can be tested
 * without a live mongod, in line with the rest of tests/.
 *
 * History worth keeping: the original scheme read countDocuments({ shop }) and
 * wrote the result into a field carrying a *collection-wide* unique index. Two
 * distinct failures came out of that:
 *
 *   - Cross-tenant collision. The count was per shop but the index was global,
 *     so every shop's first sale of a month produced INV-YYMM-00001 and only
 *     one shop on the whole platform could own it. Every other shop's sale was
 *     rejected with a duplicate key error.
 *   - Self-race. Two concurrent sales in one shop read the same count, and the
 *     read ran outside the caller's transaction so it could not see uncommitted
 *     siblings either.
 *
 * Both are fixed by moving the counter onto the Shop document and advancing it
 * with a single atomic $inc.
 */

/** Formats a sequence number as INV-YYMM-NNNNN. */
export const formatInvoiceNumber = (seq, now = new Date()) => {
  const year = now.getFullYear().toString().slice(-2);
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  return `INV-${year}${month}-${seq.toString().padStart(5, '0')}`;
};

/**
 * Claims the next invoice number for a shop.
 *
 * The $inc is atomic, so concurrent callers are handed distinct values without
 * any read-then-write window. When a session is supplied the increment joins
 * that transaction, which means an aborted sale returns its number to the pool
 * rather than burning it.
 *
 * Numbering is lifetime-per-shop and never resets — the YYMM is a display
 * prefix only. That preserves the previous behaviour, where countDocuments()
 * counted every sale the shop had ever made rather than the current month's.
 *
 * @param {*} shopId
 * @param {{ ShopModel: *, session?: *, now?: Date }} deps
 * @returns {Promise<string>}
 */
export async function nextInvoiceNumber(shopId, { ShopModel, session = null, now = new Date() }) {
  const shop = await ShopModel.findByIdAndUpdate(
    shopId,
    { $inc: { invoiceSeq: 1 } },
    { new: true, session, select: { invoiceSeq: 1 } },
  );

  if (!shop) {
    throw new Error(`Cannot issue an invoice number: shop ${shopId} not found`);
  }

  return formatInvoiceNumber(shop.invoiceSeq, now);
}

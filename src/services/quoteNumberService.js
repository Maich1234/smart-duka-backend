/**
 * Per-shop quotation numbering.
 *
 * Mirrors invoiceNumberService.js exactly, for the same reason: a counter
 * keyed by countDocuments({ shop }) races under concurrency (two concurrent
 * quotations in one shop would read the same count) and collides across
 * shops if the uniqueness is enforced globally instead of per shop (every
 * shop's first quotation would want QUO-YYMM-00001). See
 * invoiceNumberService.js for the full history of that bug in Sale.invoiceNumber.
 *
 * Both are avoided by moving the counter onto the Shop document and
 * advancing it with a single atomic $inc.
 */

/** Formats a sequence number as QUO-YYMM-NNNNN. */
export const formatQuoteNumber = (seq, now = new Date()) => {
  const year = now.getFullYear().toString().slice(-2);
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  return `QUO-${year}${month}-${seq.toString().padStart(5, '0')}`;
};

/**
 * Claims the next quote number for a shop.
 *
 * The $inc is atomic, so concurrent callers are handed distinct values
 * without any read-then-write window. When a session is supplied the
 * increment joins that transaction, which means an aborted quotation returns
 * its number to the pool rather than burning it.
 *
 * Numbering is lifetime-per-shop and never resets — the YYMM is a display
 * prefix only.
 *
 * @param {*} shopId
 * @param {{ ShopModel: *, session?: *, now?: Date }} deps
 * @returns {Promise<string>}
 */
export async function nextQuoteNumber(shopId, { ShopModel, session = null, now = new Date() }) {
  const shop = await ShopModel.findByIdAndUpdate(
    shopId,
    { $inc: { quoteNumberSeq: 1 } },
    { new: true, session, select: { quoteNumberSeq: 1 } },
  );

  if (!shop) {
    throw new Error(`Cannot issue a quote number: shop ${shopId} not found`);
  }

  return formatQuoteNumber(shop.quoteNumberSeq, now);
}

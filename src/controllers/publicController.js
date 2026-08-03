import { verifyBookStamp } from '../utils/bookStamp.js';
import Sale from '../models/Sale.js';
import Rating from '../models/Rating.js';
import { verifyReceiptToken } from '../utils/receiptToken.js';

export const getPublicReceipt = async (req, res) => {
  const saleId = verifyReceiptToken(req.params.token);
  if (!saleId) {
    return res.status(400).json({ success: false, message: 'Invalid or unrecognized receipt code' });
  }

  const sale = await Sale.findById(saleId).populate('shop', 'name phone currency');
  if (!sale) {
    return res.status(404).json({ success: false, message: 'Receipt not found' });
  }

  const rating = await Rating.findOne({ sale: sale._id });

  res.json({
    success: true,
    data: {
      invoiceNumber: sale.invoiceNumber,
      shopName: sale.shop?.name,
      currency: sale.shop?.currency,
      totalAmount: sale.totalAmount,
      itemCount: sale.items.length,
      createdAt: sale.createdAt,
      alreadyRated: !!rating,
      rating: rating ? { stars: rating.stars, comment: rating.comment } : null,
    },
  });
};

export const submitPublicRating = async (req, res) => {
  const saleId = verifyReceiptToken(req.params.token);
  if (!saleId) {
    return res.status(400).json({ success: false, message: 'Invalid or unrecognized receipt code' });
  }

  const { stars, comment } = req.body;
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    return res.status(400).json({ success: false, message: 'Stars must be a whole number between 1 and 5' });
  }

  const sale = await Sale.findById(saleId);
  if (!sale) {
    return res.status(404).json({ success: false, message: 'Receipt not found' });
  }

  const existing = await Rating.findOne({ sale: sale._id });
  if (existing) {
    return res.json({ success: true, data: existing, message: 'You already rated this receipt — thank you!' });
  }

  const rating = await Rating.create({
    shop: sale.shop,
    sale: sale._id,
    staff: sale.staff,
    stars,
    comment: typeof comment === 'string' && comment.trim() ? comment.trim().slice(0, 500) : undefined,
  });

  res.status(201).json({ success: true, data: rating, message: 'Thank you for your feedback!' });
};

/**
 * GET /public/books/verify/:token — confirms a downloaded book is genuine.
 *
 * Unauthenticated on purpose: the point is that a bank, a landlord or an
 * accountant who was handed a PDF can check it without a Smart Duka account.
 *
 * Answers "did Smart Duka produce this, for this shop and period, with these
 * figures, and has it been altered since" — and says plainly that it is not
 * an audit opinion, because a verification page is exactly where someone
 * would otherwise infer one.
 */
export const verifyBookDocument = async (req, res) => {
  const attested = verifyBookStamp(req.params.token);

  if (!attested) {
    return res.status(404).json({
      success: false,
      verified: false,
      message: "This code doesn't match a document Smart Duka produced. It may have been mistyped, or the document may have been altered.",
    });
  }

  res.json({
    success: true,
    verified: true,
    data: {
      documentId: attested.documentId,
      title: attested.title,
      shopName: attested.shopName,
      period: { from: attested.from, to: attested.to },
      generatedAt: attested.generatedAt,
      totals: attested.totals,
      // Stated in the payload rather than left to the client, so every
      // surface repeats the same limit on what this confirms.
      assurance:
        'Confirms this document was produced by Smart Duka from the shop\'s own records and has not been altered. It is not an audit or an accountant\'s opinion.',
    },
  });
};

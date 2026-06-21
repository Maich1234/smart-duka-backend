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

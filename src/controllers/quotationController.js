import Quotation from '../models/Quotation.js';
import Customer from '../models/Customer.js';
import Product from '../models/Product.js';
import { parsePagination, paginatedResult } from '../utils/pagination.js';
import { escapeRegex } from '../utils/escapeRegex.js';
import { signQuotationToken } from '../utils/quotationToken.js';
import { createSaleTransaction, SaleRejection } from '../services/saleCreationService.js';
import { CreditRejection, canMakeCreditSale } from '../services/creditService.js';
import { CREDIT_METHOD_KEY } from '../constants/credit.js';
import { notifyOwnersNegativeStock } from './saleController.js';

/**
 * Drafting and managing quotations.
 *
 * `create_quotation` gates drafting/editing/declining/deleting — it has no
 * financial effect. `convert_quotation_to_sale` (checked by a later task's
 * convert endpoint, not here) is what actually moves stock/money, so it also
 * counts as "may see the list" here even though it can't create one.
 */

const round2 = (n) => Math.round(n * 100) / 100;

const canManageQuotations = (user) =>
  user.role === 'owner' || !!user.permissions?.includes('create_quotation');

const canViewQuotations = (user) =>
  canManageQuotations(user) || !!user.permissions?.includes('convert_quotation_to_sale');

const canConvertQuotation = (user) =>
  user.role === 'owner' || !!user.permissions?.includes('convert_quotation_to_sale');

/** Resolves the client's item list into priced lines + a subtotal, without trusting any client-sent price for a catalog line. */
async function resolveQuotationItems(shop, items) {
  const productIds = [...new Set(items.filter((i) => i.productId).map((i) => String(i.productId)))];
  const products = productIds.length
    ? await Product.find({ _id: { $in: productIds }, shop }).lean()
    : [];
  const productMap = new Map(products.map((p) => [String(p._id), p]));

  let subtotal = 0;
  const resolved = items.map((item) => {
    if (item.productId) {
      const product = productMap.get(String(item.productId));
      if (!product) {
        const err = new Error(`Product with ID ${item.productId} not found in this shop`);
        err.status = 400;
        throw err;
      }
      const unitPrice = item.unitPrice ?? product.sellingPrice;
      const subtotalLine = round2(unitPrice * item.quantity);
      subtotal += subtotalLine;
      return {
        productId: product._id,
        name: product.name,
        description: item.description || '',
        quantity: item.quantity,
        unitPrice,
        subtotal: subtotalLine,
      };
    }
    const subtotalLine = round2(item.unitPrice * item.quantity);
    subtotal += subtotalLine;
    return {
      name: item.name,
      description: item.description || '',
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      subtotal: subtotalLine,
    };
  });

  return { resolved, subtotal: round2(subtotal) };
}

function present(quotation) {
  const obj = quotation.toObject ? quotation.toObject() : quotation;
  return { ...obj, publicToken: signQuotationToken(obj._id) };
}

export const createQuotation = async (req, res) => {
  if (!canManageQuotations(req.user)) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const shop = req.user.shop._id;
  const { customerId, items, notes, validUntil } = req.body;

  const customer = await Customer.findOne({ _id: customerId, shop }).lean();
  if (!customer) {
    return res.status(404).json({ success: false, message: 'Customer not found' });
  }

  let resolved;
  let subtotal;
  try {
    ({ resolved, subtotal } = await resolveQuotationItems(shop, items));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    throw err;
  }

  const taxRate = req.user.shop.taxRate || 0;
  const taxAmount = round2(subtotal * (taxRate / 100));
  const total = round2(subtotal + taxAmount);

  const quotation = await Quotation.create({
    shop,
    customer: customer._id,
    customerSnapshot: { name: customer.name, phone: customer.phone || '', email: customer.email || '' },
    items: resolved,
    subtotal,
    taxRate,
    taxAmount,
    total,
    notes: notes || '',
    validUntil,
    createdBy: req.user._id,
    createdByName: req.user.name,
  });

  res.status(201).json({ success: true, data: present(quotation) });
};

export const getQuotations = async (req, res) => {
  if (!canViewQuotations(req.user)) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const shop = req.user.shop._id;
  const { status, search } = req.query;
  const { page, limit, skip } = parsePagination(req.query);

  const query = { shop };
  if (status) query.status = status;
  if (search) {
    const rx = { $regex: escapeRegex(search), $options: 'i' };
    query.$or = [{ quoteNumber: rx }, { 'customerSnapshot.name': rx }];
  }

  const result = await paginatedResult(
    { page, limit, skip },
    (s, l) => Quotation.find(query).sort({ createdAt: -1 }).skip(s).limit(l),
    () => Quotation.countDocuments(query),
  );

  res.json({ success: true, data: result.data.map(present), pagination: result.pagination });
};

export const getQuotationById = async (req, res) => {
  if (!canViewQuotations(req.user)) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const shop = req.user.shop._id;
  const quotation = await Quotation.findOne({ _id: req.params.id, shop });
  if (!quotation) return res.status(404).json({ success: false, message: 'Quotation not found' });
  res.json({ success: true, data: present(quotation) });
};

export const updateQuotation = async (req, res) => {
  if (!canManageQuotations(req.user)) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const shop = req.user.shop._id;
  const { customerId, items, notes, validUntil } = req.body;

  const quotation = await Quotation.findOne({ _id: req.params.id, shop, status: 'draft' });
  if (!quotation) {
    return res.status(400).json({ success: false, message: 'Only a draft quotation can be edited.' });
  }

  const customer = await Customer.findOne({ _id: customerId, shop }).lean();
  if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

  let resolved;
  let subtotal;
  try {
    ({ resolved, subtotal } = await resolveQuotationItems(shop, items));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    throw err;
  }

  const taxRate = req.user.shop.taxRate || 0;
  const taxAmount = round2(subtotal * (taxRate / 100));

  quotation.set({
    customer: customer._id,
    customerSnapshot: { name: customer.name, phone: customer.phone || '', email: customer.email || '' },
    items: resolved,
    subtotal,
    taxRate,
    taxAmount,
    total: round2(subtotal + taxAmount),
    notes: notes || '',
    validUntil,
  });
  await quotation.save();

  res.json({ success: true, data: present(quotation) });
};

export const declineQuotation = async (req, res) => {
  if (!canManageQuotations(req.user)) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }
  const quotation = await Quotation.findOneAndUpdate(
    { _id: req.params.id, shop: req.user.shop._id, status: 'draft' },
    { $set: { status: 'declined' } },
    { new: true },
  );
  if (!quotation) {
    return res.status(400).json({ success: false, message: 'Only a draft quotation can be declined.' });
  }
  res.json({ success: true, data: present(quotation) });
};

export const deleteQuotation = async (req, res) => {
  if (!canManageQuotations(req.user)) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }
  const quotation = await Quotation.findOne({ _id: req.params.id, shop: req.user.shop._id });
  if (!quotation) return res.status(404).json({ success: false, message: 'Quotation not found' });
  if (quotation.status === 'converted') {
    return res.status(400).json({ success: false, message: 'A converted quotation cannot be deleted — see its linked sale instead.' });
  }
  await quotation.deleteOne();
  res.json({ success: true, message: 'Quotation deleted' });
};

/**
 * POST /quotations/:id/convert — turns a draft quotation into a real Sale via
 * the shared createSaleTransaction (see saleCreationService.js), then flips
 * the quotation to 'converted' inside that same Mongo transaction.
 *
 * convert_quotation_to_sale is deliberately never a backdoor around the
 * shop's credit policy: converting to a credit sale independently requires
 * make_credit_sale, exactly like a till credit sale would.
 */
export const convertQuotation = async (req, res) => {
  if (!canConvertQuotation(req.user)) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const shop = req.user.shop._id;
  const { paymentMethod, mpesaTransactionId, mpesaReceiptNumber } = req.body;
  const idempotencyKey = req.headers['x-idempotency-key'] ?? req.headers['idempotency-key'] ?? null;

  const quotation = await Quotation.findOne({ _id: req.params.id, shop });
  if (!quotation) {
    return res.status(404).json({ success: false, message: 'Quotation not found' });
  }
  if (quotation.status !== 'draft') {
    return res.status(400).json({ success: false, message: `This quotation is already ${quotation.status} and cannot be converted.` });
  }

  // Converting to a credit sale must pass through the exact same permission
  // gate a till credit sale does — convert_quotation_to_sale alone is never
  // enough. createSaleTransaction itself also calls canMakeCreditSale
  // internally, but checking it here too gives a clean 403 with a message
  // specific to conversion rather than a generic SaleRejection.
  if (paymentMethod === CREDIT_METHOD_KEY && !canMakeCreditSale(req.user)) {
    return res.status(403).json({
      success: false,
      code: 'CREDIT_PERMISSION_DENIED',
      message: "You don't have permission to sell on credit.",
    });
  }

  const items = quotation.items.map((i) => ({
    productId: i.productId || undefined,
    name: i.name,
    quantity: i.quantity,
    unitPrice: i.unitPrice,
  }));

  try {
    const { saleObj, creditResult, negativeStockAlerts, creditCustomerName } = await createSaleTransaction({
      user: req.user,
      items,
      paymentMethod,
      mpesaTransactionId,
      mpesaReceiptNumber,
      customerId: String(quotation.customer),
      idempotencyKey,
      // Runs inside the same Mongo transaction as the Sale write. The
      // status: 'draft' filter is the idempotency guard: a retried request
      // (offline queue replay, double-tap) finds the quotation already
      // 'converted' and this update matches nothing, aborting the whole
      // transaction — including the Sale that was about to be created —
      // before a second Sale can ever be committed.
      beforeCommit: async (session, sale) => {
        const updated = await Quotation.findOneAndUpdate(
          { _id: quotation._id, status: 'draft' },
          { $set: { status: 'converted', convertedSale: sale._id } },
          { session },
        );
        if (!updated) {
          throw new SaleRejection(400, 'This quotation was already converted.');
        }
      },
    });

    if (negativeStockAlerts.length > 0) {
      await notifyOwnersNegativeStock(shop, req.user.name, negativeStockAlerts);
    }

    res.status(201).json({
      success: true,
      data: { ...saleObj, quotationId: quotation._id },
      message: creditResult
        ? `Sale recorded on ${creditCustomerName}'s account.`
        : 'Quotation converted to a sale.',
    });
  } catch (error) {
    if (error instanceof SaleRejection) {
      return res.status(error.status).json({ success: false, message: error.message });
    }
    if (error instanceof CreditRejection) {
      return res.status(error.status).json({
        success: false,
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      });
    }
    throw error;
  }
};

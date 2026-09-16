import Quotation from '../models/Quotation.js';
import Customer from '../models/Customer.js';
import Product from '../models/Product.js';
import { parsePagination, paginatedResult } from '../utils/pagination.js';
import { escapeRegex } from '../utils/escapeRegex.js';
import { signQuotationToken } from '../utils/quotationToken.js';

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

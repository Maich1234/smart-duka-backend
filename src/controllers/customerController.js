import Customer from '../models/Customer.js';
import CreditTransaction from '../models/CreditTransaction.js';
import Sale from '../models/Sale.js';
import { parsePagination } from '../utils/pagination.js';
import { escapeRegex } from '../utils/escapeRegex.js';
import { logAudit } from '../services/auditLogService.js';
import { resolveCreditSettings, money, MONEY_EPSILON } from '../constants/credit.js';
import {
  canMakeCreditSale,
  canViewAllCredit,
  canViewCustomerAccount,
  ledgerScopeFor,
  summariseAccount,
} from '../services/creditService.js';

/**
 * Customers, and their credit account with this shop.
 *
 * Every query in this file is scoped `{ shop: req.user.shop._id }` and the shop
 * always comes from the authenticated session, never the request — a customer
 * of Shop A is not reachable from Shop B by guessing an id. A wrong-tenant id
 * therefore 404s rather than 403s: telling someone "that exists but isn't
 * yours" is itself a disclosure.
 */

/**
 * Who may open the customer directory.
 *
 * Wider than the credit permissions alone: a cashier picking a regular customer
 * for an ordinary cash sale needs the list, and they already hold record_sale.
 * A staff member drafting a quotation needs it too, since a quotation requires
 * a real customer reference and create_quotation carries no financial effect
 * of its own. Balances are only included for someone who may see credit (see
 * below).
 */
const canListCustomers = (user) =>
  canViewCustomerAccount(user)
  || !!user.permissions?.includes('record_sale')
  || !!user.permissions?.includes('create_quotation');

/** Strips the credit block for a caller who may transact but not see the book. */
const shapeForViewer = (customer, settings, user, now) => {
  const plain = typeof customer.toObject === 'function' ? customer.toObject() : customer;
  if (!canViewCustomerAccount(user)) {
    delete plain.credit;
    return plain;
  }
  return { ...plain, account: summariseAccount(plain, settings, { now }) };
};

export const getCustomers = async (req, res) => {
  if (!canListCustomers(req.user)) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const shop = req.user.shop._id;
  const settings = resolveCreditSettings(req.user.shop);
  const { search, filter, includeArchived, sort } = req.query;
  const { page, limit, skip } = parsePagination(req.query);

  const query = { shop };
  // Archived customers stay out of the picker but are never deleted — they are
  // referenced by sales and by a debt ledger. Only the owner can ask for them.
  if (!(includeArchived && req.user.role === 'owner')) query.isActive = true;

  if (search) {
    const rx = { $regex: escapeRegex(search), $options: 'i' };
    query.$or = [{ name: rx }, { phone: rx }];
  }

  // The Credit section's filter chips. Only meaningful for a viewer who can
  // see balances — for anyone else the filters are ignored rather than
  // becoming an oracle for balances they may not read.
  if (canViewCustomerAccount(req.user)) {
    if (filter === 'outstanding') query['credit.outstanding'] = { $gt: MONEY_EPSILON };
    else if (filter === 'overdue') query['credit.status'] = 'overdue';
    else if (filter === 'paid') query['credit.status'] = 'paid';
  }

  const sortSpec = sort === 'outstanding'
    ? { 'credit.outstanding': -1, name: 1 }
    : sort === 'recent'
      ? { updatedAt: -1 }
      : { name: 1 };

  const [customers, total] = await Promise.all([
    Customer.find(query).sort(sortSpec).skip(skip).limit(limit).lean(),
    Customer.countDocuments(query),
  ]);

  const now = new Date();
  res.json({
    success: true,
    data: customers.map((c) => shapeForViewer(c, settings, req.user, now)),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
};

/**
 * One customer's account: the balance, what they may still take, and the
 * timeline.
 *
 * The ledger is narrowed in the database by ledgerScopeFor — a staff member
 * with only view_own_credit is served their own entries by the query, never
 * handed the whole book to filter on the device.
 *
 * The summary (balance, limit, available, due date) is shown to anyone who may
 * sell on credit or take a repayment, because deciding either without it is
 * guesswork. That is a narrower disclosure than the timeline, which is why the
 * two are gated separately.
 */
export const getCustomerById = async (req, res) => {
  if (!canListCustomers(req.user)) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const shop = req.user.shop._id;
  const customer = await Customer.findOne({ _id: req.params.id, shop }).lean();
  if (!customer) {
    return res.status(404).json({ success: false, message: 'Customer not found' });
  }

  const settings = resolveCreditSettings(req.user.shop);
  const now = new Date();
  const shaped = shapeForViewer(customer, settings, req.user, now);

  if (!canViewCustomerAccount(req.user)) {
    // A cashier who can only attach a customer to a cash sale gets the contact
    // record and nothing about what anyone owes.
    return res.json({ success: true, data: { ...shaped, transactions: [], recentSales: [] } });
  }

  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 25 });
  const ledgerQuery = { shop, customer: customer._id, ...ledgerScopeFor(req.user) };

  const [transactions, transactionsTotal, recentSales] = await Promise.all([
    CreditTransaction.find(ledgerQuery).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    CreditTransaction.countDocuments(ledgerQuery),
    Sale.find({ shop, customer: customer._id })
      .select('invoiceNumber totalAmount paymentMethod paymentMethodLabel status createdAt')
      .sort({ createdAt: -1 })
      .limit(5)
      .lean(),
  ]);

  res.json({
    success: true,
    data: {
      ...shaped,
      transactions,
      recentSales,
      // Tells the client its timeline is a subset, so it can say so rather
      // than implying the customer has no other history.
      scopedToSelf: !canViewAllCredit(req.user),
      pagination: {
        page,
        limit,
        total: transactionsTotal,
        pages: Math.ceil(transactionsTotal / limit),
      },
    },
  });
};

export const createCustomer = async (req, res) => {
  // Anyone who may sell on credit may add the person they're selling to —
  // otherwise a new customer at the counter is a dead end. Setting their
  // limit is a separate, owner-only decision (below).
  if (req.user.role !== 'owner' && !canMakeCreditSale(req.user)) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const { name, phone, email, notes, creditLimit } = req.body;
  const shop = req.user.shop._id;

  const customer = await Customer.create({
    shop,
    name,
    phone: phone ?? '',
    email: email ?? '',
    notes: notes ?? '',
    // A staff member's creditLimit is dropped, not rejected: a client form may
    // carry the field blank, and failing the whole request over a field the
    // user never filled in would be hostile. The limit simply stays null and
    // the shop default applies.
    ...(req.user.role === 'owner' && creditLimit !== undefined ? { credit: { limit: creditLimit } } : {}),
  });

  if (req.user.role === 'owner' && creditLimit != null) {
    await logAudit({
      shopId: shop,
      userId: req.user._id,
      action: 'credit.customer.limit_set',
      entityType: 'Customer',
      entityId: customer._id,
      details: { creditLimit, at: 'create' },
      req,
    });
  }

  const settings = resolveCreditSettings(req.user.shop);
  res.status(201).json({
    success: true,
    data: shapeForViewer(customer, settings, req.user, new Date()),
  });
};

/**
 * Edits a customer.
 *
 * Split deliberately: contact details are counter work, the credit limit and
 * the block flag are the shop's exposure. A staff member with make_credit_sale
 * who could raise a limit would be setting their own ceiling, so those two
 * fields are owner-only and audited — the point of least privilege here is
 * that "can lend" never implies "can decide how much".
 */
export const updateCustomer = async (req, res) => {
  const isOwner = req.user.role === 'owner';
  if (!isOwner && !canMakeCreditSale(req.user)) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const shop = req.user.shop._id;
  const customer = await Customer.findOne({ _id: req.params.id, shop });
  if (!customer) {
    return res.status(404).json({ success: false, message: 'Customer not found' });
  }

  const { name, phone, email, notes, creditLimit, creditBlocked, creditBlockedReason } = req.body;

  if (name !== undefined) customer.name = name;
  if (phone !== undefined) customer.phone = phone;
  if (email !== undefined) customer.email = email;
  if (notes !== undefined) customer.notes = notes;

  const financialChanges = {};
  if (!isOwner) {
    // Rejected rather than ignored: unlike a blank create form, sending these
    // on an update is an explicit attempt to change the shop's exposure, and
    // silently dropping it would leave the caller believing it worked.
    if (creditLimit !== undefined || creditBlocked !== undefined || creditBlockedReason !== undefined) {
      return res.status(403).json({
        success: false,
        code: 'OWNER_ONLY_FIELD',
        message: 'Only the shop owner can change a credit limit or block a customer from credit.',
      });
    }
  } else {
    if (creditLimit !== undefined && creditLimit !== customer.credit.limit) {
      financialChanges.creditLimit = { from: customer.credit.limit, to: creditLimit };
      customer.credit.limit = creditLimit;
    }
    if (creditBlocked !== undefined && creditBlocked !== customer.credit.blocked) {
      financialChanges.blocked = { from: customer.credit.blocked, to: creditBlocked };
      customer.credit.blocked = creditBlocked;
    }
    if (creditBlockedReason !== undefined) customer.credit.blockedReason = creditBlockedReason;
  }

  await customer.save();

  if (Object.keys(financialChanges).length > 0) {
    await logAudit({
      shopId: shop,
      userId: req.user._id,
      action: 'credit.customer.updated',
      entityType: 'Customer',
      entityId: customer._id,
      details: financialChanges,
      req,
    });
  }

  const settings = resolveCreditSettings(req.user.shop);
  res.json({ success: true, data: shapeForViewer(customer, settings, req.user, new Date()) });
};

/**
 * Archives a customer. Never deletes: the record is referenced by sales and by
 * an immutable debt ledger, and a ledger whose counterparty has vanished is
 * not a ledger.
 *
 * Refused while money is owed. Hiding a debtor from the Credit section is
 * exactly the wrong thing to make easy — the debt would still be counted in
 * the shop's totals while being unreachable from any list.
 */
export const archiveCustomer = async (req, res) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ success: false, message: 'Only the shop owner can archive a customer.' });
  }

  const shop = req.user.shop._id;
  const customer = await Customer.findOne({ _id: req.params.id, shop });
  if (!customer) {
    return res.status(404).json({ success: false, message: 'Customer not found' });
  }

  if (money(customer.credit?.outstanding ?? 0) > MONEY_EPSILON) {
    return res.status(400).json({
      success: false,
      code: 'CUSTOMER_HAS_DEBT',
      message: `${customer.name} still owes money. Record the repayment, or reverse the debt, before archiving.`,
    });
  }

  customer.isActive = false;
  await customer.save();

  await logAudit({
    shopId: shop,
    userId: req.user._id,
    action: 'credit.customer.archived',
    entityType: 'Customer',
    entityId: customer._id,
    req,
  });

  res.json({ success: true, message: `${customer.name} archived. Their history is kept.` });
};

import Shop from '../models/Shop.js';
import Subscription from '../models/Subscription.js';
import PlatformConfig from '../models/PlatformConfig.js';
import User from '../models/User.js';
import EmployeeReferralPayout from '../models/EmployeeReferralPayout.js';
import cloudinary from '../config/cloudinary.js';
import { resolvePaymentMethods } from '../constants/salePaymentMethods.js';
import { generateShopReferralCode, generateStaffReferralCode } from '../utils/referralCode.js';

export const getShopConfig = async (req, res) => {
  const shop = await Shop.findById(req.user.shop._id);
  if (!shop) return res.status(404).json({ success: false, message: 'Shop not found' });
  // Shops predating owner-defined till buttons have no list stored; hand back
  // the defaults so the client renders Cash + M-PESA instead of nothing.
  res.json({ success: true, data: { ...shop.toObject(), paymentMethods: resolvePaymentMethods(shop) } });
};

export const updateShopConfig = async (req, res) => {
  const { name, address, phone, email, taxRate, country, currency, receiptThankYouNote, logoUrl, motto, shiftManagementEnabled, showStaffCommission, purchasingEnabled, purchaseCostAllocationMethod, aiEnabled, barcodeScanningEnabled, paymentMethods } = req.body;
  const shop = await Shop.findById(req.user.shop._id);
  if (!shop) return res.status(404).json({ success: false, message: 'Shop not found' });

  if (name !== undefined) shop.name = name;
  if (address !== undefined) shop.address = address;
  if (phone !== undefined) shop.phone = phone;
  if (email !== undefined) shop.email = email;
  if (taxRate !== undefined) shop.taxRate = taxRate;
  if (country !== undefined) shop.country = country;
  if (currency !== undefined) shop.currency = currency;
  if (receiptThankYouNote !== undefined) shop.receiptThankYouNote = receiptThankYouNote;
  if (logoUrl !== undefined) shop.logoUrl = logoUrl;
  if (motto !== undefined) shop.motto = motto;
  if (shiftManagementEnabled !== undefined) shop.shiftManagementEnabled = shiftManagementEnabled;
  if (showStaffCommission !== undefined) shop.showStaffCommission = showStaffCommission;
  if (purchasingEnabled !== undefined) shop.purchasingEnabled = purchasingEnabled;
  if (purchaseCostAllocationMethod !== undefined) shop.purchaseCostAllocationMethod = purchaseCostAllocationMethod;
  if (aiEnabled !== undefined) shop.aiEnabled = aiEnabled;
  if (barcodeScanningEnabled !== undefined) shop.barcodeScanningEnabled = barcodeScanningEnabled;
  // Sent whole, stored whole — array position is the till's button order.
  if (paymentMethods !== undefined) {
    shop.paymentMethods = paymentMethods.map((m, i) => ({ ...m, order: i }));
  }

  await shop.save();
  res.json({ success: true, data: { ...shop.toObject(), paymentMethods: resolvePaymentMethods(shop) } });
};

// Same PUBLIC_WEB_URL convention as cronController.js/bookStamp.js.
const webUrl = () => (process.env.PUBLIC_WEB_URL || 'https://duqana.app').replace(/\/+$/, '');

/**
 * GET /shop/referrals — this shop's own shareable code, its currently banked
 * discount, and who it has referred so far. No financial or contact details
 * of a referred shop are exposed, only name + conversion status — an owner
 * can see *that* they referred someone, not what that shop is doing.
 */
export const getShopReferrals = async (req, res) => {
  const shopId = req.user.shop._id;
  const [shop, subscription, platform, referredShops] = await Promise.all([
    Shop.findById(shopId).select('myReferralCode'),
    Subscription.findOne({ shop: shopId }).select('referralDiscountPercent'),
    PlatformConfig.get(),
    Shop.find({ referredByShopId: shopId }).select('name createdAt referralRewardGranted').sort({ createdAt: -1 }).lean(),
  ]);
  if (!shop) return res.status(404).json({ success: false, message: 'Shop not found' });

  // Self-healing backfill: shops that registered before myReferralCode
  // existed (or any other gap) otherwise show `undefined` here forever —
  // there's no migration script, so the first read just fixes it.
  let code = shop.myReferralCode;
  if (!code) {
    code = await generateShopReferralCode();
    shop.myReferralCode = code;
    await shop.save();
  }

  const audience = platform.referral?.shopOwner;
  res.json({
    success: true,
    data: {
      code,
      shareUrl: `${webUrl()}/register?ref=${code}`,
      enabled: audience?.enabled ?? false,
      perReferralPercent: audience?.percentPerReferral ?? 0,
      discountPercentBanked: subscription?.referralDiscountPercent ?? 0,
      referrals: referredShops.map((s) => ({
        shopName: s.name,
        status: s.referralRewardGranted ? 'converted' : 'pending',
        joinedAt: s.createdAt,
      })),
    },
  });
};

/**
 * GET /shop/referrals/me — a staff member's own shareable referral code and
 * cash-bonus ledger. Separate from getShopReferrals above: that endpoint is
 * the shop's own (owner-facing) code and subscription-credit balance; this
 * one is per-staff-member and pays real money, tracked in
 * EmployeeReferralPayout and settled manually by a platform admin.
 */
export const getMyReferralData = async (req, res) => {
  if (req.user.role !== 'staff') {
    return res.status(403).json({ success: false, message: 'Not available for this account.' });
  }

  let code = req.user.myReferralCode;
  if (!code) {
    code = await generateStaffReferralCode();
    // Race-safe: if two requests land here at once, the loser's write hits
    // the unique index and is discarded — the winner's code is what sticks,
    // and both responses still return a valid code either way.
    const updated = await User.findOneAndUpdate(
      { _id: req.user._id, myReferralCode: { $exists: false } },
      { myReferralCode: code },
      { new: true },
    ).catch((err) => {
      if (err.code === 11000) return null;
      throw err;
    });
    if (!updated) {
      code = (await User.findById(req.user._id).select('myReferralCode')).myReferralCode;
    }
  }

  const [platform, payouts] = await Promise.all([
    PlatformConfig.get(),
    EmployeeReferralPayout.find({ staffId: req.user._id })
      .populate('referredShopId', 'name')
      .sort({ createdAt: -1 })
      .lean(),
  ]);

  const audience = platform.referral?.employee;
  res.json({
    success: true,
    data: {
      code,
      shareUrl: `${webUrl()}/register?ref=${code}`,
      enabled: audience?.enabled ?? false,
      cashAmount: audience?.cashAmount ?? 0,
      payouts: payouts.map((p) => ({
        shopName: p.referredShopId?.name ?? 'Referred shop',
        amount: p.amount,
        status: p.status,
        joinedAt: p.createdAt,
      })),
      totalPending: payouts.filter((p) => p.status === 'pending').reduce((sum, p) => sum + p.amount, 0),
      totalPaid: payouts.filter((p) => p.status === 'paid').reduce((sum, p) => sum + p.amount, 0),
    },
  });
};

export const uploadShopLogo = async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

  const shop = await Shop.findById(req.user.shop._id);
  if (!shop) return res.status(404).json({ success: false, message: 'Shop not found' });

  const result = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'shop-logos', public_id: `shop_${shop._id}`, overwrite: true },
      (error, result) => (error ? reject(error) : resolve(result))
    );
    stream.end(req.file.buffer);
  });

  shop.logoUrl = result.secure_url;
  await shop.save();

  res.json({ success: true, data: { logoUrl: shop.logoUrl } });
};
import Shop from '../models/Shop.js';
import cloudinary from '../config/cloudinary.js';
import { resolvePaymentMethods } from '../constants/salePaymentMethods.js';

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
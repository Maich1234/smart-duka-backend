import Shop from '../models/Shop.js';

export const getShopConfig = async (req, res) => {
  const shop = await Shop.findById(req.user.shop._id);
  res.json({ success: true, data: shop });
};

export const updateShopConfig = async (req, res) => {
  const { name, address, phone, email, taxRate } = req.body;
  const shop = await Shop.findById(req.user.shop._id);
  if (!shop) return res.status(404).json({ success: false, message: 'Shop not found' });

  if (name !== undefined) shop.name = name;
  if (address !== undefined) shop.address = address;
  if (phone !== undefined) shop.phone = phone;
  if (email !== undefined) shop.email = email;
  if (taxRate !== undefined) shop.taxRate = taxRate;

  await shop.save();
  res.json({ success: true, data: shop });
};
import ShopConfig from '../models/ShopConfig.js';

export const getShopConfig = async (req, res) => {
  let config = await ShopConfig.findOne();
  if (!config) {
    config = await ShopConfig.create({});
  }
  res.json({ success: true, data: config });
};

export const updateShopConfig = async (req, res) => {
  let config = await ShopConfig.findOne();
  if (!config) {
    config = new ShopConfig();
  }

  const { shopName, address, phone, email, taxRate } = req.body;
  if (shopName !== undefined) config.shopName = shopName;
  if (address !== undefined) config.address = address;
  if (phone !== undefined) config.phone = phone;
  if (email !== undefined) config.email = email;
  if (taxRate !== undefined) config.taxRate = taxRate;

  await config.save();
  res.json({ success: true, data: config });
};
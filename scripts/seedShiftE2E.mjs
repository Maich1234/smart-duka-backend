// Throwaway seed for the shift-management E2E drive (local test Mongo only).
import mongoose from 'mongoose';
import Shop from '../src/models/Shop.js';
import User from '../src/models/User.js';
import Product from '../src/models/Product.js';

const MONGO = 'mongodb://127.0.0.1:28017/smartduka_shift_test';

await mongoose.connect(MONGO);
await mongoose.connection.dropDatabase();

const ownerId = new mongoose.Types.ObjectId();
const shop = await Shop.create({
  name: 'Shift Test Duka',
  owner: ownerId,
  currency: 'KES',
});

await User.create({
  _id: ownerId,
  name: 'Olivia Owner',
  email: 'owner@test.com',
  password: 'Password1',
  role: 'owner',
  shop: shop._id,
  isActive: true,
  isEmailVerified: true,
});

await User.create({
  name: 'Sam Staff',
  email: 'staff@test.com',
  password: 'Password1',
  role: 'staff',
  shop: shop._id,
  isActive: true,
  isEmailVerified: true,
  permissions: ['record_sale', 'manage_expenses', 'edit_product_stock'],
});

const product = await Product.create({
  shop: shop._id,
  name: 'Milk 500ml',
  sellingPrice: 65,
  costPrice: 45,
  quantity: 100,
  category: 'Dairy',
});

console.log(JSON.stringify({ shopId: shop._id, productId: product._id }));
await mongoose.disconnect();

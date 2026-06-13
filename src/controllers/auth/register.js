import mongoose from 'mongoose';
import User from '../../models/User.js';
import Shop from '../../models/Shop.js';
import { sendVerificationEmail } from '../../utils/emailVerification.js';

export const register = async (req, res) => {
  const { name, email, password, shopName, address, phone } = req.body;

  if (!name || !email || !password || !shopName) {
    return res.status(400).json({ success: false, message: 'Missing required fields: name, email, password, shopName' });
  }

  const existingUser = await User.findOne({ email });
  if (existingUser) {
    return res.status(400).json({ success: false, message: 'Email already registered' });
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const [shop] = await Shop.create([{ name: shopName, address: address || '', phone: phone || '', owner: null }], { session });
    const [user] = await User.create([{
      name, email, password, role: 'owner', shop: shop._id, isActive: true, isEmailVerified: false,
    }], { session });

    shop.owner = user._id;
    await shop.save({ session });

    await session.commitTransaction();

    sendVerificationEmail(user).catch(err => console.error('Email sending failed:', err));

    res.status(201).json({
      success: true,
      message: 'Registration successful. Please check your email to verify your account.',
    });
  } catch (error) {
    await session.abortTransaction();
    console.error('Registration error:', error);
    res.status(500).json({ success: false, message: 'Registration failed. Please try again.' });
  } finally {
    session.endSession();
  }
};
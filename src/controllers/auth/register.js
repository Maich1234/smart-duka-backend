import mongoose from 'mongoose';
import User from '../../models/User.js';
import Shop from '../../models/Shop.js';
import { CURRENT_TERMS_VERSION } from '../../constants/legal.js';
import { sendVerificationEmail } from '../../utils/emailVerification.js';

export const register = async (req, res) => {
  const { name, email, password, shopName, address, phone, acceptedTerms } = req.body;

  if (!name || !email || !password || !shopName) {
    return res.status(400).json({ success: false, message: 'Missing required fields: name, email, password, shopName' });
  }

  // Enforced server-side, not just by a disabled button: the checkbox is only
  // meaningful if an account cannot exist without it. Recorded below with the
  // version accepted, so we can prove what this person agreed to and when.
  if (acceptedTerms !== true) {
    return res.status(400).json({
      success: false,
      code: 'TERMS_NOT_ACCEPTED',
      message: 'Please accept the Terms of Service and Privacy Policy to create an account.',
    });
  }

  const existingUser = await User.findOne({ email });
  if (existingUser) {
    return res.status(400).json({ success: false, message: 'Email already registered' });
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  let user;

  try {
    const shopId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();

    [user] = await User.create([{
      _id: userId,
      name,
      email,
      password,
      role: 'owner',
      shop: shopId,
      isActive: true,
      isEmailVerified: false,
      termsAcceptedAt: new Date(),
      termsVersion: CURRENT_TERMS_VERSION,
    }], { session });
    await Shop.create([{ _id: shopId, name: shopName, address: address || '', phone: phone || '', owner: userId }], { session });

    await session.commitTransaction();
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }

  // Awaited, not fire-and-forget, and deliberately after the transaction has
  // been committed. A serverless invocation is frozen the moment the response is
  // flushed, so work left dangling behind `res.json()` simply never happens: on
  // Vercel this never even reached the *code generation*, leaving every new
  // account with no verification token at all and a verify screen that could
  // only ever answer "invalid or expired code".
  //
  // The account is already committed, so a mail failure must not fail the
  // request — it downgrades to a flag the client uses to steer the user straight
  // to "resend" instead of to an inbox that will stay empty.
  let emailSent = true;
  try {
    await sendVerificationEmail(user);
  } catch (err) {
    emailSent = false;
    console.error('[register] verification email failed for', user.email, '-', err.message);
  }

  res.status(201).json({
    success: true,
    emailSent,
    message: emailSent
      ? 'Registration successful. Please check your email to verify your account.'
      : 'Account created, but we could not send your verification email. Please tap resend to try again.',
  });
};
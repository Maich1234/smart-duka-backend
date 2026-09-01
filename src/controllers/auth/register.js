import mongoose from 'mongoose';
import User from '../../models/User.js';
import Shop from '../../models/Shop.js';
import AgentReferralCode from '../../models/AgentReferralCode.js';
import AgentReferralRedemption from '../../models/AgentReferralRedemption.js';
import { CURRENT_TERMS_VERSION } from '../../constants/legal.js';
import { sendVerificationEmail } from '../../utils/emailVerification.js';
import { generateShopReferralCode } from '../../utils/referralCode.js';

/**
 * Resolves a signup's referralCode input against the three possible
 * issuers, in order: another shop's own code, a staff member's own code, an
 * agent's code (mirrored from dukana-admin-backend — see
 * AgentReferralCode.js). First match wins; no match is a silent no-op, same
 * as the pre-existing shop-only behavior.
 */
async function resolveReferrer(referredByCode) {
  if (!referredByCode) return { referredByType: null, referredByShopId: null, referredByStaffId: null, referredByAgentId: null };

  const shopMatch = await Shop.findOne({ myReferralCode: referredByCode }).select('_id');
  if (shopMatch) {
    return { referredByType: 'shop', referredByShopId: shopMatch._id, referredByStaffId: null, referredByAgentId: null };
  }

  const staffMatch = await User.findOne({ role: 'staff', myReferralCode: referredByCode }).select('_id');
  if (staffMatch) {
    return { referredByType: 'staff', referredByShopId: null, referredByStaffId: staffMatch._id, referredByAgentId: null };
  }

  const agentMatch = await AgentReferralCode.findOne({ code: referredByCode, active: true }).select('agentId');
  if (agentMatch) {
    return { referredByType: 'agent', referredByShopId: null, referredByStaffId: null, referredByAgentId: agentMatch.agentId };
  }

  return { referredByType: null, referredByShopId: null, referredByStaffId: null, referredByAgentId: null };
}

export const register = async (req, res) => {
  const { name, email, password, shopName, address, phone, acceptedTerms, referralCode } = req.body;

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

  // Resolved before the transaction — a benign race with another shop
  // registering at the same instant just means this lookup misses (falls
  // back to "no referrer"), never a torn write.
  const referredByCode = (referralCode || '').trim().toUpperCase();
  const { referredByType, referredByShopId, referredByStaffId, referredByAgentId } = await resolveReferrer(referredByCode);
  const myReferralCode = await generateShopReferralCode();

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
    await Shop.create([{
      _id: shopId,
      name: shopName,
      address: address || '',
      phone: phone || '',
      owner: userId,
      referredByCode,
      referredByType,
      referredByShopId,
      referredByStaffId,
      referredByAgentId,
      myReferralCode,
    }], { session });

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

  // Same non-fatal, post-commit pattern as the verification email above.
  // dukana-admin-backend's daily cron reads this row (see
  // agentReferralLinkService.js there) to create the Onboarding link this
  // backend has no connection to write directly.
  if (referredByType === 'agent') {
    try {
      await AgentReferralRedemption.create({
        agentId: referredByAgentId,
        code: referredByCode,
        shopId: user.shop,
        ownerUserId: user._id,
      });
    } catch (err) {
      console.error('[register] agent referral redemption record failed for', user.shop, '-', err.message);
    }
  }

  res.status(201).json({
    success: true,
    emailSent,
    message: emailSent
      ? 'Registration successful. Please check your email to verify your account.'
      : 'Account created, but we could not send your verification email. Please tap resend to try again.',
  });
};
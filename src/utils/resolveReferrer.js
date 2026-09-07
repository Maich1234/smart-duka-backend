import User from '../models/User.js';
import Shop from '../models/Shop.js';
import AgentReferralCode from '../models/AgentReferralCode.js';

/**
 * Resolves a signup's referralCode input against the three possible
 * issuers, in order: another shop's own code, a staff member's own code, an
 * agent's code (mirrored from dukana-admin-backend — see
 * AgentReferralCode.js). First match wins; no match is a silent no-op, same
 * as the pre-existing shop-only behavior.
 *
 * Shared by both the password-registration transaction and the Google
 * new-owner-signup transaction — extracted here so the two never drift.
 */
export default async function resolveReferrer(referredByCode) {
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

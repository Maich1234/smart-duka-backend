import Shop from '../../../models/Shop.js';
import User from '../../../models/User.js';
import Subscription from '../../../models/Subscription.js';
import PlatformConfig from '../../../models/PlatformConfig.js';
import EmployeeReferralPayout from '../../../models/EmployeeReferralPayout.js';
import { isReferralAudienceActive } from '../../../utils/referralAudience.js';

/**
 * Rewards whoever referred this shop, exactly once, the first time this
 * shop's subscription actually activates. Guarded by
 * Shop.referralRewardGranted rather than inferred from subscription state,
 * so a cancel/resubscribe cycle can never double-reward the referrer and a
 * later admin re-enabling the program can never retroactively reward a
 * conversion that happened while it was off — both cases still flip the flag
 * without granting anything.
 *
 * Only the 'shop' and 'staff' referral types are handled here. An 'agent'
 * referral's reward stays entirely on the existing CommissionRule/
 * CommissionRecord machinery in dukana-admin-backend, driven off the
 * Onboarding row dukana-admin-backend's own daily cron creates — this
 * function does nothing for that case (see agentReferralLinkService.js
 * there) and leaves referralRewardGranted untouched, since nothing here
 * needs the flag as a double-grant guard.
 */
export async function rewardReferrerIfFirstConversion(shopId) {
  const shop = await Shop.findById(shopId).select('referredByType referredByShopId referredByStaffId referralRewardGranted');
  if (!shop || !shop.referredByType || shop.referralRewardGranted) return;

  const platform = await PlatformConfig.get();

  if (shop.referredByType === 'shop' && shop.referredByShopId) {
    const audience = platform.referral?.shopOwner;
    if (isReferralAudienceActive(audience) && audience.percentPerReferral > 0) {
      const referrerSubscription = await Subscription.findOne({ shop: shop.referredByShopId });
      if (referrerSubscription) {
        referrerSubscription.referralDiscountPercent = Math.min(
          (referrerSubscription.referralDiscountPercent || 0) + audience.percentPerReferral,
          audience.maxStackedPercent,
        );
        await referrerSubscription.save();
      }
    }
    shop.referralRewardGranted = true;
    await shop.save();
  } else if (shop.referredByType === 'staff' && shop.referredByStaffId) {
    const audience = platform.referral?.employee;
    if (isReferralAudienceActive(audience) && audience.cashAmount > 0) {
      const staff = await User.findById(shop.referredByStaffId).select('shop');
      if (staff) {
        try {
          await EmployeeReferralPayout.create({
            staffId: staff._id,
            shopId: staff.shop,
            referredShopId: shop._id,
            amount: audience.cashAmount,
          });
        } catch (err) {
          // Unique index on referredShopId guards a double-grant if this
          // function is ever re-run for the same conversion — anything else
          // is a genuine failure and must surface.
          if (err.code !== 11000) throw err;
        }
      }
    }
    shop.referralRewardGranted = true;
    await shop.save();
  }
}

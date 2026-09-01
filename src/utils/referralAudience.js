// Shared enabled+date-window check for a PlatformConfig.referral.* audience
// sub-document (shopOwner/employee/agent) — same startsAt/endsAt semantics
// as Promotion.isRedeemable(), centralized so each grant point doesn't
// re-implement it.
export function isReferralAudienceActive(audience, now = new Date()) {
  if (!audience || !audience.enabled) return false;
  if (audience.startsAt && now < audience.startsAt) return false;
  if (audience.endsAt && now > audience.endsAt) return false;
  return true;
}

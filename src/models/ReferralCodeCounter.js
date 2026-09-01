import mongoose from 'mongoose';

// One document per code type ('shop_referral_code', 'staff_referral_code').
// The only thing referralCode.js's generator needs to never repeat is `seq`
// — advanced with a single atomic $inc, same "no read-then-write window" as
// Shop.invoiceSeq (see invoiceNumberService.js). Uniqueness of the resulting
// *code* then falls out of encodeReferralCode's bijective encoding, not a
// database probe.
const referralCodeCounterSchema = new mongoose.Schema({
  _id: { type: String },
  seq: { type: Number, default: 0 },
});

export default mongoose.model('ReferralCodeCounter', referralCodeCounterSchema);

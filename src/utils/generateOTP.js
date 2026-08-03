import crypto from 'crypto';

// crypto.randomInt, not Math.random: this OTP is the sole credential in the
// password-reset flow, and V8 seeds Math.random with a per-context xorshift128+
// state that can be reconstructed from a handful of observed outputs. An
// attacker who triggers a few resets against their own address could then
// predict the code sent to someone else's — a straight account takeover.
// randomInt draws from the CSPRNG and is uniform over the range.
export const generateOTP = () => crypto.randomInt(100000, 1000000).toString();

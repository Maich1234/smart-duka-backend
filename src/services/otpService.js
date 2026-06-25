import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import PaymentVerificationSession from '../models/PaymentVerificationSession.js';
import { sendSMS } from './africasTalkingService.js';

const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const BCRYPT_ROUNDS = 8;

function generateOTP() {
  const bytes = crypto.randomBytes(4);
  const num = bytes.readUInt32BE(0);
  return String(num % 1_000_000).padStart(6, '0');
}

function maskPhone(phone) {
  if (!phone) return 'your phone';
  const cleaned = String(phone).replace(/\s/g, '');
  if (cleaned.length < 4) return cleaned;
  return cleaned.slice(0, -3).replace(/\d/g, '*') + cleaned.slice(-3);
}

function maskEmail(email) {
  if (!email) return 'your email';
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const masked = local[0] + '*'.repeat(Math.max(1, local.length - 1));
  return `${masked}@${domain}`;
}

function getEmailTransporter() {
  const port = Number(process.env.SMTP_PORT) || 587;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
}

async function sendEmailOTP(email, otp) {
  const transporter = getEmailTransporter();
  await transporter.sendMail({
    from: process.env.SMTP_FROM || '"Smart Duka" <noreply@smartduka.app>',
    to: email,
    subject: 'Smart Duka — Payment Settings Verification Code',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
        <h2 style="color:#0F766E;margin:0 0 8px">Smart Duka</h2>
        <p style="color:#64748B;margin:0 0 24px;font-size:14px">Payment Settings Verification</p>
        <div style="background:#F8FAFC;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
          <p style="margin:0 0 8px;font-size:14px;color:#64748B">Your verification code</p>
          <div style="font-size:36px;font-weight:700;letter-spacing:8px;color:#0F172A;font-family:monospace">${otp}</div>
        </div>
        <p style="font-size:13px;color:#64748B;margin:0">
          This code expires in <strong>10 minutes</strong>. Do not share it with anyone.
        </p>
      </div>
    `,
  });
}

/**
 * Creates a new OTP session and delivers the code to the user.
 * Returns { sessionId, sentTo } — the masked delivery address for display.
 */
export async function requestOTP(user, method) {
  await PaymentVerificationSession.deleteMany({ userId: user._id, isUsed: false });

  const otp = generateOTP();
  const otpHash = await bcrypt.hash(otp, BCRYPT_ROUNDS);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  let sentTo;
  if (method === 'sms') {
    if (!user.phone) throw new Error('No phone number on file. Use email verification instead.');
    await sendSMS(user.phone, `Your Smart Duka verification code is: ${otp}. Valid for 10 minutes. Do not share.`);
    sentTo = maskPhone(user.phone);
  } else {
    if (!user.email) throw new Error('No email address on file.');
    await sendEmailOTP(user.email, otp);
    sentTo = maskEmail(user.email);
  }

  const session = await PaymentVerificationSession.create({
    userId: user._id,
    shopId: user.shop._id ?? user.shop,
    method,
    otpHash,
    expiresAt,
    sentTo,
  });

  return { sessionId: session._id.toString(), sentTo };
}

/**
 * Validates a submitted OTP code. On success, issues a signed verification JWT
 * with a 10-minute lifetime. That token must accompany all sensitive API calls
 * via the X-Verification-Token header.
 */
export async function verifyOTP(sessionId, code, userId) {
  const session = await PaymentVerificationSession.findOne({
    _id: sessionId,
    userId,
    isUsed: false,
  });

  if (!session) throw new Error('Verification session not found or already used.');
  if (new Date() > session.expiresAt) throw new Error('Verification code has expired. Please request a new one.');
  if (session.attempts >= MAX_ATTEMPTS) throw new Error('Too many failed attempts. Please request a new code.');

  const match = await bcrypt.compare(String(code), session.otpHash);
  if (!match) {
    session.attempts += 1;
    session.lastAttemptAt = new Date();
    await session.save();
    const remaining = MAX_ATTEMPTS - session.attempts;
    throw new Error(`Incorrect code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`);
  }

  session.isUsed = true;
  await session.save();

  const token = jwt.sign(
    { userId: userId.toString(), shopId: session.shopId.toString(), purpose: 'payment_config' },
    process.env.JWT_SECRET,
    { expiresIn: '10m' }
  );

  return token;
}

/**
 * Express middleware: verifies the X-Verification-Token header.
 * Must be placed after protect() so req.user is set.
 */
export function requireVerificationToken(req, res, next) {
  const token = req.headers['x-verification-token'];
  if (!token) {
    return res.status(403).json({
      success: false,
      message: 'Identity verification required. Please complete verification before accessing payment settings.',
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.purpose !== 'payment_config') {
      return res.status(403).json({ success: false, message: 'Invalid verification token.' });
    }
    if (decoded.userId !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Verification token mismatch.' });
    }
    req.verificationSession = decoded;
    next();
  } catch {
    return res.status(403).json({
      success: false,
      message: 'Verification session expired. Please verify your identity again.',
    });
  }
}

import nodemailer from 'nodemailer';

// Retries have to fit inside the serverless function's max duration, so the
// whole send — every attempt plus backoff — is capped by one budget, and no
// single attempt may outlast the budget's remainder. Hanging until the platform
// kills the function is strictly worse than failing fast: the caller gets a 504
// instead of a structured, retryable error.
//
// SOCKET_TIMEOUT_MS is an *inactivity* timeout, and the longest silence in an
// SMTP conversation is the one after end-of-DATA, while the receiving host runs
// the message through its spam/virus scanners. The old 6s ceiling turned a
// working mail host into a coin flip — every verification email raced a timeout
// it usually lost. Connection setup, by contrast, is fast or never, so it keeps
// a tighter bound.
//
// Sized against mail.enmail.co as measured 2026-08-03: accepted messages sat at
// a suspiciously uniform 26-27s before returning `250 Ok`, and roughly one send
// in five came back `451 4.3.0 queue file write error`. Those are symptoms of a
// sick mail host, not a healthy one that is merely slow, so treat these numbers
// as headroom for a degraded provider rather than a target to design around —
// if enmail is repaired or replaced, they can come back down.
const SEND_BUDGET_MS = 34000;
const SOCKET_TIMEOUT_MS = 30000;
const CONNECT_TIMEOUT_MS = 8000;
// The 451 above fails fast (~2s), which is exactly the case a retry rescues; a
// full-length 27s attempt leaves no budget for a second one, and the guard in
// the loop stops us from starting one we cannot finish.
const MAX_ATTEMPTS = 2;
const BACKOFF_MS = [500];

// Connection-level failures worth a second look. EAUTH is deliberately absent:
// bad credentials never fix themselves on retry.
const TRANSIENT_CODES = new Set([
  'ETIMEDOUT',
  'ECONNECTION',
  'ECONNRESET',
  'ESOCKET',
  'EPIPE',
  'EDNS',
]);

/**
 * Thrown when a message could not be handed off to the SMTP server.
 * `transient` distinguishes "the mail host is having a moment" (SMTP 4.x.x,
 * dropped sockets) from "this message will never be accepted" (5.x.x, auth
 * failures), so callers can offer a retry or an alternate channel.
 */
export class MailDeliveryError extends Error {
  constructor(message, { transient, cause, detail }) {
    super(message);
    this.name = 'MailDeliveryError';
    this.transient = transient;
    this.cause = cause;
    // Raw SMTP response, for logs only. Kept off `message` because callers do
    // surface that to clients (otpController interpolates it into its reply),
    // and a mail host's rejection text can name internal hosts, relay policy and
    // software versions — none of which a shop owner can act on.
    this.detail = detail;
  }
}

const isTransient = (err) => {
  // 4.x.x is retry-later per RFC 5321; 5.x.x is permanent.
  if (err?.responseCode >= 400 && err.responseCode < 500) return true;
  return TRANSIENT_CODES.has(err?.code);
};

// The From domain should match the authenticated mailbox — mail hosts commonly
// refuse, or spam-file, envelopes that claim an unrelated sender.
//
// SMTP_FROM is easy to set wrongly: `SMTP_FROM="DuQana" <noreply@x.com>` in a
// .env parses to the bare display name `DuQana`, because the quoted section
// terminates the value. Nodemailer then finds no address and sends MAIL FROM:<>,
// a null return-path reserved for bounces, which receivers spam-file or reject.
// So an SMTP_FROM with no address in it is treated as a display name only.
const fromAddress = () => {
  const configured = process.env.SMTP_FROM?.trim();
  const user = process.env.SMTP_USER?.trim();

  if (configured?.includes('@')) return configured;
  if (configured && user) return `"${configured.replace(/"/g, '')}" <${user}>`;
  if (user) return `"DuQana" <${user}>`;
  return '"DuQana" <noreply@duqana.app>';
};

// Built per send: nodemailer opens no connection here (there is no pool), so
// caching would buy nothing while pinning whatever the env said the first time.
const getTransporter = (budgetLeftMs) => {
  const port = parseInt(process.env.SMTP_PORT) || 587;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    connectionTimeout: Math.min(CONNECT_TIMEOUT_MS, budgetLeftMs),
    greetingTimeout: Math.min(CONNECT_TIMEOUT_MS, budgetLeftMs),
    socketTimeout: Math.min(SOCKET_TIMEOUT_MS, budgetLeftMs),
  });
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Send a generic email, retrying transient SMTP failures.
 * @param {string} to - Recipient email
 * @param {string} subject - Email subject
 * @param {string} html - HTML content
 * @param {string} text - Plain text fallback (optional)
 * @param {Record<string,string>} [headers] - Extra SMTP headers (e.g. List-Unsubscribe)
 * @throws {MailDeliveryError}
 */
export const sendEmail = async (to, subject, html, text = null, headers = undefined) => {
  const mailOptions = {
    from: fromAddress(),
    to,
    subject,
    html,
    text: text || html.replace(/<[^>]*>/g, ''), // simple plain text fallback
    ...(headers ? { headers } : {}),
  };

  const deadline = Date.now() + SEND_BUDGET_MS;
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const budgetLeft = deadline - Date.now();
    if (budgetLeft <= 0) break;

    // Closed explicitly rather than left to GC: a timed-out attempt leaves its
    // socket open, and on a frozen-then-thawed serverless instance those pile up
    // against the mail host's per-IP connection cap until it starts refusing us.
    const transporter = getTransporter(budgetLeft);
    try {
      return await transporter.sendMail(mailOptions);
    } catch (err) {
      lastError = err;
      const transient = isTransient(err);
      console.error(
        `[email] send to ${to} failed (attempt ${attempt}/${MAX_ATTEMPTS}, ` +
          `code=${err?.code ?? '-'} response=${err?.responseCode ?? '-'} transient=${transient}):`,
        err?.response ?? err?.message
      );

      if (!transient) break;

      const backoff = BACKOFF_MS[attempt - 1];
      if (attempt === MAX_ATTEMPTS || backoff == null) break;
      if (Date.now() + backoff >= deadline) break; // out of budget; fail now
      await sleep(backoff);
    } finally {
      transporter.close();
    }
  }

  const transient = isTransient(lastError);
  throw new MailDeliveryError(
    transient
      ? 'The mail server is temporarily unavailable. Please try again in a few minutes.'
      : 'The email could not be delivered. Please check the address and try again.',
    {
      transient,
      cause: lastError,
      detail: lastError?.response ?? lastError?.message ?? 'unknown error',
    }
  );
};

/**
 * Send OTP email for password reset
 * @param {string} to - Recipient email
 * @param {string} otp - One‑time password
 * @param {string} name - User's name
 */
export const sendOTPEmail = async (to, otp, name = 'User') => {
  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"><title>Password Reset OTP - DuQana</title></head>
    <body style="font-family: sans-serif;">
      <div style="max-width: 500px; margin: 40px auto; background: #fff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
        <div style="background-color: #1B4F3D; padding: 24px; text-align: center;">
          <h1 style="color: #fff; margin: 0;">DuQana</h1>
        </div>
        <div style="padding: 32px 24px;">
          <p>Hello <strong>${escapeHtml(name)}</strong>,</p>
          <p>You requested to reset your password. Use the following OTP:</p>
          <div style="background-color: #f0f2f5; font-size: 32px; font-weight: bold; letter-spacing: 8px; text-align: center; padding: 16px; border-radius: 12px; margin: 24px 0; font-family: monospace;">${otp}</div>
          <p>This code expires in <strong>10 minutes</strong>.</p>
          <p>If you did not request this, please ignore this email.</p>
        </div>
        <div style="background-color: #f8fafc; padding: 16px; text-align: center; font-size: 12px; color: #64748b;">
          &copy; ${new Date().getFullYear()} DuQana. All rights reserved.
        </div>
      </div>
    </body>
    </html>
  `;
  const text = `Hello ${name},\n\nYou requested to reset your password. Your OTP is: ${otp}\nThis code expires in 10 minutes.\n\nIf you did not request this, please ignore this email.`;

  await sendEmail(to, 'Password Reset OTP - DuQana', html, text);
};

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>]/g, function(m) {
    if (m === '&') return '&amp;';
    if (m === '<') return '&lt;';
    if (m === '>') return '&gt;';
    return m;
  });
}
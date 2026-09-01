import crypto from 'crypto';
import EmailVerificationToken from '../models/EmailVerificationToken.js';
import { sendEmail } from './email.js';

// Generate a random 6-digit code.
//
// crypto.randomInt, not Math.random: V8 seeds Math.random with a per-context
// xorshift128+ state that can be reconstructed from a handful of observed
// outputs, which would let anyone who registered a few throwaway accounts
// predict the next person's code. randomInt draws from the CSPRNG and is
// uniform over the range (no modulo bias).
const generateSixDigitCode = () => crypto.randomInt(100000, 1000000).toString();

/**
 * Generate and store a verification code for a user
 */
export const generateEmailVerificationCode = async (userId) => {
  // Delete any existing unused codes for this user
  await EmailVerificationToken.deleteMany({ userId });
  const code = generateSixDigitCode();
  await EmailVerificationToken.create({ userId, code });
  return code;
};

/**
 * Send verification email with 6‑digit code
 */
export const sendVerificationEmail = async (user) => {
  if (!user || !user.email || !user.name) {
    throw new Error('Invalid user data for verification email');
  }

  const code = await generateEmailVerificationCode(user._id);

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Verify Your Email - DuQana</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
        .container { max-width: 500px; margin: 40px auto; background: #fff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
        .header { background-color: #1B4F3D; padding: 24px; text-align: center; }
        .header h1 { color: #fff; margin: 0; font-size: 24px; }
        .content { padding: 32px 24px; }
        .code-box { background-color: #f0f2f5; font-size: 32px; font-weight: bold; letter-spacing: 8px; text-align: center; padding: 16px; border-radius: 12px; margin: 24px 0; font-family: monospace; }
        .footer { background-color: #f8fafc; padding: 16px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>DuQana</h1>
        </div>
        <div class="content">
          <p>Hello <strong>${escapeHtml(user.name)}</strong>,</p>
          <p>Please verify your email address to start using DuQana.</p>
          <div class="code-box">${code}</div>
          <p>Enter this code in the app to complete your verification.</p>
          <p>This code expires in <strong>24 hours</strong>.</p>
          <p>If you did not create this account, please ignore this email.</p>
        </div>
        <div class="footer">
          &copy; ${new Date().getFullYear()} DuQana. All rights reserved.
        </div>
      </div>
    </body>
    </html>
  `;

  const text = `Hello ${user.name},\n\nPlease verify your email address to start using DuQana.\n\nYour verification code is: ${code}\n\nThis code expires in 24 hours.\n\nIf you did not create this account, please ignore this email.\n\n-- DuQana Team`;

  await sendEmail(user.email, 'Verify your email - DuQana', html, text);
};

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>]/g, (m) => {
    if (m === '&') return '&amp;';
    if (m === '<') return '&lt;';
    if (m === '>') return '&gt;';
    return m;
  });
}
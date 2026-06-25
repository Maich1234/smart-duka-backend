import nodemailer from 'nodemailer';

const getTransporter = () => {
  const port = parseInt(process.env.SMTP_PORT) || 587;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
};

/**
 * Send a generic email
 * @param {string} to - Recipient email
 * @param {string} subject - Email subject
 * @param {string} html - HTML content
 * @param {string} text - Plain text fallback (optional)
 */
export const sendEmail = async (to, subject, html, text = null) => {
  const transporter = getTransporter();
  const mailOptions = {
    from: process.env.SMTP_FROM || '"Smart Duka" <noreply@smartduka.com>',
    to,
    subject,
    html,
    text: text || html.replace(/<[^>]*>/g, ''), // simple plain text fallback
  };
  await transporter.sendMail(mailOptions);
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
    <head><meta charset="UTF-8"><title>Password Reset OTP - Smart Duka</title></head>
    <body style="font-family: sans-serif;">
      <div style="max-width: 500px; margin: 40px auto; background: #fff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
        <div style="background-color: #1B4F3D; padding: 24px; text-align: center;">
          <h1 style="color: #fff; margin: 0;">Smart Duka</h1>
        </div>
        <div style="padding: 32px 24px;">
          <p>Hello <strong>${escapeHtml(name)}</strong>,</p>
          <p>You requested to reset your password. Use the following OTP:</p>
          <div style="background-color: #f0f2f5; font-size: 32px; font-weight: bold; letter-spacing: 8px; text-align: center; padding: 16px; border-radius: 12px; margin: 24px 0; font-family: monospace;">${otp}</div>
          <p>This code expires in <strong>10 minutes</strong>.</p>
          <p>If you did not request this, please ignore this email.</p>
        </div>
        <div style="background-color: #f8fafc; padding: 16px; text-align: center; font-size: 12px; color: #64748b;">
          &copy; ${new Date().getFullYear()} Smart Duka. All rights reserved.
        </div>
      </div>
    </body>
    </html>
  `;
  const text = `Hello ${name},\n\nYou requested to reset your password. Your OTP is: ${otp}\nThis code expires in 10 minutes.\n\nIf you did not request this, please ignore this email.`;

  await sendEmail(to, 'Password Reset OTP - Smart Duka', html, text);
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
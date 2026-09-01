// Shared branded HTML for subscription / payment-link emails. The
// resend-link controller and the subscription-reminders cron both send the
// same visual shell around different copy, so it's built once here instead
// of duplicated as bare <p> tags at each call site.
//
// Table layout + inline styles (not a <style> block for structure) are
// deliberate: Outlook desktop's Word rendering engine ignores flexbox/grid
// and most CSS in <head>, and remote images are blocked by default in most
// clients, so the brand mark is styled text, never a hero image that would
// render as a broken icon for most recipients.

// Official brand-mark colors (constants/BRAND in components/brand/DukanaMark.tsx
// in the mobile repo) — the logo's own palette, not the lighter in-app UI teal,
// since this is outward-facing brand identity rather than app chrome.
const BRAND = {
  green: '#004B39',
  gold: '#E0A653',
  text: '#0F172A',
  textSecondary: '#64748B',
  textMuted: '#94A3B8',
  border: '#E2E8F0',
  bg: '#F8FAFC',
};

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'info@dukana.app';
const SUPPORT_PHONE = '+254 107 596 454';
const FONT_STACK = '-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif';

export const SUBSCRIPTION_UNSUBSCRIBE_MAILTO = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Stop billing reminder emails')}`;

const escapeHtml = (str) =>
  String(str ?? '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[m]));

/**
 * Renders a branded, table-based transactional email for subscription /
 * payment-link notices.
 * @returns {{ html: string, text: string }}
 */
export function renderSubscriptionEmail({
  preheader,
  ownerName,
  shopName,
  heading,
  message,
  detailRows = [],
  ctaLabel,
  ctaUrl,
}) {
  const greetName = ownerName ? escapeHtml(ownerName.split(' ')[0]) : 'there';
  const rows = detailRows.filter((r) => r.value);

  const rowsHtml = rows
    .map(
      (r) => `
        <tr>
          <td style="padding:10px 0;border-top:1px solid ${BRAND.border};color:${BRAND.textSecondary};font-size:14px;font-family:${FONT_STACK};">${escapeHtml(r.label)}</td>
          <td style="padding:10px 0;border-top:1px solid ${BRAND.border};color:${BRAND.text};font-size:14px;font-weight:600;text-align:right;font-family:${FONT_STACK};">${escapeHtml(r.value)}</td>
        </tr>`
    )
    .join('');

  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>${escapeHtml(heading)}</title>
<style>
  @media only screen and (max-width: 600px) {
    .container { width: 100% !important; }
    .stack-pad { padding-left: 20px !important; padding-right: 20px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${BRAND.bg};-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">
    ${escapeHtml(preheader || message)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND.bg};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background-color:#FFFFFF;border-radius:16px;overflow:hidden;border:1px solid ${BRAND.border};">
          <tr>
            <td style="background-color:${BRAND.green};padding:28px 32px;" align="center">
              <span style="font-family:${FONT_STACK};font-size:22px;font-weight:800;letter-spacing:0.5px;color:${BRAND.gold};">DuQana</span>
            </td>
          </tr>
          <tr>
            <td class="stack-pad" style="padding:36px 40px 8px;font-family:${FONT_STACK};">
              <h1 style="margin:0 0 16px;font-size:20px;line-height:28px;color:${BRAND.text};font-weight:700;">${escapeHtml(heading)}</h1>
              <p style="margin:0 0 16px;font-size:15px;line-height:24px;color:${BRAND.text};">Hi ${greetName},</p>
              <p style="margin:0 0 20px;font-size:15px;line-height:24px;color:${BRAND.text};">${escapeHtml(message)}</p>
              ${rowsHtml ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 24px;">${rowsHtml}</table>` : ''}
            </td>
          </tr>
          <tr>
            <td class="stack-pad" align="center" style="padding:4px 40px 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="border-radius:10px;background-color:${BRAND.green};">
                    <a href="${ctaUrl}" style="display:inline-block;padding:14px 32px;font-family:${FONT_STACK};font-size:15px;font-weight:700;color:${BRAND.gold};text-decoration:none;border-radius:10px;">${escapeHtml(ctaLabel)}</a>
                  </td>
                </tr>
              </table>
              <p style="margin:16px 0 0;font-size:12px;line-height:18px;color:${BRAND.textSecondary};word-break:break-all;font-family:${FONT_STACK};">Or paste this link into your browser:<br><a href="${ctaUrl}" style="color:${BRAND.textSecondary};">${ctaUrl}</a></p>
            </td>
          </tr>
          <tr>
            <td class="stack-pad" style="padding:20px 40px 28px;border-top:1px solid ${BRAND.border};font-family:${FONT_STACK};">
              <p style="margin:0 0 6px;font-size:12px;line-height:18px;color:${BRAND.textSecondary};">
                Sent to you as the owner of ${shopName ? `${escapeHtml(shopName)} on ` : ''}DuQana. This is an automated account notice — replies to this address aren't monitored.
              </p>
              <p style="margin:0;font-size:12px;line-height:18px;color:${BRAND.textSecondary};">
                Need help? Email <a href="mailto:${SUPPORT_EMAIL}" style="color:${BRAND.textSecondary};">${SUPPORT_EMAIL}</a> or call ${SUPPORT_PHONE}.
              </p>
              <p style="margin:12px 0 0;font-size:11px;line-height:16px;color:${BRAND.textMuted};">
                &copy; ${new Date().getFullYear()} DuQana. This is a billing notice for your active or trial subscription, not a marketing email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = [
    `Hi ${ownerName ? ownerName.split(' ')[0] : 'there'},`,
    '',
    message,
    '',
    ...rows.map((r) => `${r.label}: ${r.value}`),
    '',
    `${ctaLabel}: ${ctaUrl}`,
    '',
    `Need help? Email ${SUPPORT_EMAIL} or call ${SUPPORT_PHONE}.`,
    'This is an automated account notice from DuQana — replies aren\'t monitored.',
  ].join('\n');

  return { html, text };
}

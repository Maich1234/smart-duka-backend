import PDFDocument from 'pdfkit';
import { sanitize } from './books/renderers/pdf.js';

/**
 * Renders a quotation into a PDF, using pdfkit directly rather than a
 * headless-browser/HTML intermediate — this runs in a Vercel serverless
 * function, and shipping a browser to render a page would dominate both the
 * bundle and the cold start (same reasoning as src/services/books/renderers/pdf.js).
 *
 * Pure function: no database, no Express. `quotationData` is the same shape
 * getPublicQuotation returns.
 *
 * Free-text fields (shop name, customer name, item name/description, notes)
 * are run through the shared sanitize() before drawing. The standard
 * Helvetica font only encodes WinAnsi/Latin-1: for a character outside that
 * range, pdfkit's AFMFont.encodeText writes the raw codepoint's hex digits
 * into the PDF content stream regardless of length (2 hex digits for Latin-1,
 * 3+ for anything past U+00FF), which desyncs the byte-pair boundaries of
 * every hex string operand that follows it — corrupting not just that
 * character but the rest of the line. sanitize() strips those characters
 * before they ever reach pdfkit, so this never happens.
 */

const formatMoney = (n, currency = 'KES') =>
  `${currency} ${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const formatDate = (d) => new Date(d).toLocaleDateString('en-KE', { year: 'numeric', month: 'short', day: 'numeric' });

/** Sanitizes only the free-text fields a template draws as user-supplied text. */
function sanitizeQuotationData(data) {
  return {
    ...data,
    shopName: sanitize(data.shopName),
    shopAddress: sanitize(data.shopAddress),
    notes: sanitize(data.notes),
    customerSnapshot: { ...data.customerSnapshot, name: sanitize(data.customerSnapshot.name) },
    // toPdfData passes quotation.items straight from the Mongoose document in
    // production — a live subdocument, not a plain object. `{...item}` on one
    // of those spreads its internal bookkeeping props (_doc, $__,
    // __parentArray) rather than its schema fields, so quantity/unitPrice/
    // subtotal silently came through as undefined/NaN below (name/description
    // only survived because they're re-assigned explicitly, after the
    // spread). .toObject() normalizes a real subdocument to a plain object
    // first; plain-object items (as the tests use) pass through unchanged.
    items: data.items.map((item) => ({
      ...(item.toObject ? item.toObject() : item),
      name: sanitize(item.name),
      description: sanitize(item.description),
    })),
  };
}

function bufferFromDoc(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

function drawItemsTable(doc, data, { headerColor, top }) {
  const currency = data.currency || 'KES';
  let y = top;
  doc.fontSize(9).fillColor('#ffffff');
  doc.rect(50, y, 495, 20).fill(headerColor);
  doc.fillColor('#ffffff').text('Description', 58, y + 6, { width: 260 });
  doc.text('Qty', 320, y + 6, { width: 50, align: 'right' });
  doc.text('Unit Price', 370, y + 6, { width: 80, align: 'right' });
  doc.text('Total', 455, y + 6, { width: 80, align: 'right' });
  y += 24;

  doc.fillColor('#1a1a1a').fontSize(9);
  for (const item of data.items) {
    doc.text(item.name, 58, y, { width: 260 });
    if (item.description) doc.fontSize(7.5).fillColor('#666').text(item.description, 58, y + 12, { width: 260 }).fontSize(9).fillColor('#1a1a1a');
    doc.text(String(item.quantity), 320, y, { width: 50, align: 'right' });
    doc.text(formatMoney(item.unitPrice, currency), 370, y, { width: 80, align: 'right' });
    doc.text(formatMoney(item.subtotal, currency), 455, y, { width: 80, align: 'right' });
    y += item.description ? 30 : 20;
  }

  y += 10;
  doc.moveTo(320, y).lineTo(545, y).strokeColor('#dddddd').stroke();
  y += 8;
  doc.text('Subtotal', 370, y, { width: 80, align: 'right' });
  doc.text(formatMoney(data.subtotal, currency), 455, y, { width: 80, align: 'right' });
  y += 16;
  if (data.taxAmount > 0) {
    doc.text(`Tax (${data.taxRate}%)`, 370, y, { width: 80, align: 'right' });
    doc.text(formatMoney(data.taxAmount, currency), 455, y, { width: 80, align: 'right' });
    y += 16;
  }
  doc.fontSize(12).fillColor(headerColor).text('Total', 370, y, { width: 80, align: 'right' });
  doc.text(formatMoney(data.total, currency), 455, y, { width: 80, align: 'right' });
  return y + 30;
}

function drawFooter(doc, data, y) {
  doc.fontSize(8).fillColor('#666');
  if (data.notes) {
    doc.text('Notes', 50, y);
    doc.text(data.notes, 50, y + 12, { width: 495 });
    y += 40;
  }
  doc.text(`Valid until ${formatDate(data.validUntil)}. This is a quotation, not a tax invoice.`, 50, y, { width: 495, align: 'center' });
}

function classicTemplate(doc, data) {
  doc.fontSize(20).fillColor('#1a1a1a').font('Helvetica-Bold').text(data.shopName, 50, 50);
  doc.fontSize(9).font('Helvetica').fillColor('#666');
  if (data.shopPhone) doc.text(data.shopPhone, 50, 74);
  if (data.shopAddress) doc.text(data.shopAddress, 50, 88);
  doc.fontSize(16).fillColor('#1a1a1a').font('Helvetica-Bold').text('QUOTATION', 400, 50, { width: 145, align: 'right' });
  doc.fontSize(9).font('Helvetica').fillColor('#666')
    .text(data.quoteNumber, 400, 70, { width: 145, align: 'right' })
    .text(`Issued ${formatDate(data.createdAt)}`, 400, 84, { width: 145, align: 'right' });

  doc.moveTo(50, 105).lineTo(545, 105).strokeColor('#cccccc').stroke();

  doc.fontSize(9).fillColor('#666').text('Bill To', 50, 120);
  doc.fontSize(11).fillColor('#1a1a1a').font('Helvetica-Bold').text(data.customerSnapshot.name, 50, 134);
  doc.fontSize(9).font('Helvetica').fillColor('#666');
  if (data.customerSnapshot.phone) doc.text(data.customerSnapshot.phone, 50, 150);

  const afterTable = drawItemsTable(doc, data, { headerColor: '#0F766E', top: 190 });
  drawFooter(doc, data, afterTable);
}

function modernTemplate(doc, data) {
  doc.rect(0, 0, 595, 90).fill('#111827');
  doc.fontSize(20).fillColor('#ffffff').font('Helvetica-Bold').text(data.shopName, 50, 30);
  doc.fontSize(9).fillColor('#9ca3af').font('Helvetica');
  if (data.shopPhone) doc.text(data.shopPhone, 50, 56);
  if (data.shopAddress) doc.text(data.shopAddress, 50, 70);
  doc.fontSize(14).fillColor('#ffffff').font('Helvetica-Bold').text('QUOTATION', 400, 30, { width: 145, align: 'right' });
  doc.fontSize(9).fillColor('#9ca3af').font('Helvetica').text(data.quoteNumber, 400, 50, { width: 145, align: 'right' });

  doc.fontSize(9).fillColor('#666').text('Bill To', 50, 110);
  doc.fontSize(11).fillColor('#1a1a1a').font('Helvetica-Bold').text(data.customerSnapshot.name, 50, 124);
  doc.fontSize(9).font('Helvetica').fillColor('#666').text(`Issued ${formatDate(data.createdAt)}`, 400, 110, { width: 145, align: 'right' });

  const afterTable = drawItemsTable(doc, data, { headerColor: '#111827', top: 170 });
  drawFooter(doc, data, afterTable);
}

function minimalTemplate(doc, data) {
  doc.fontSize(11).fillColor('#1a1a1a').font('Helvetica').text(data.shopName, 50, 50);
  doc.fontSize(9).fillColor('#999').text(`Quotation ${data.quoteNumber} · ${formatDate(data.createdAt)}`, 50, 66);
  // Unlike classic/modern, this template had no existing shopPhone line to
  // anchor shopAddress after, so it's drawn as its own line here and the
  // elements below shift down to make room for it, only when present.
  let offset = 0;
  if (data.shopAddress) {
    doc.fontSize(9).fillColor('#999').text(data.shopAddress, 50, 80);
    offset = 14;
  }
  doc.moveTo(50, 90 + offset).lineTo(545, 90 + offset).strokeColor('#eeeeee').stroke();

  doc.fontSize(9).fillColor('#999').text('Bill to', 50, 105 + offset);
  doc.fontSize(11).fillColor('#1a1a1a').text(data.customerSnapshot.name, 50, 118 + offset);

  const afterTable = drawItemsTable(doc, data, { headerColor: '#374151', top: 160 + offset });
  drawFooter(doc, data, afterTable);
}

const TEMPLATES = { classic: classicTemplate, modern: modernTemplate, minimal: minimalTemplate };

export const renderQuotationPdf = async (data, template) => {
  const render = TEMPLATES[template];
  if (!render) {
    throw new Error(`Unknown quotation template: ${template}`);
  }
  const doc = new PDFDocument({ size: 'A4', margin: 0 });
  render(doc, sanitizeQuotationData(data));
  return bufferFromDoc(doc);
};

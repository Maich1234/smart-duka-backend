import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { signBookStamp, bookVerifyUrl } from '../utils/bookStamp.js';
import { sanitize } from './books/renderers/pdf.js';

const labels = { zero_or_missing_price: 'Selling price zero, negative or invalid', below_cost: 'Selling below cost', minimum_below_cost: 'Allowed minimum below cost', cost_not_set: 'Purchase cost not set', missing_variants: 'No variants configured', invalid_stock_quantity: 'Invalid stock quantity', invalid_price_range: 'Invalid allowed price range' };
const sourceLabel = source => source === 'purchase' ? 'Purchase cost updated' : source === 'created' ? 'Product created' : 'Price edited';
const dateLabel = value => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : `${date.toLocaleString('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} UTC`;
};

/** Full anomaly register first; the signed summary and verification QR finish the report. */
export async function renderPriceHealthPdf(report, shop) {
  if (report.pagination?.total > report.items.length) throw Object.assign(new Error('The full product list could not be exported. Please retry the report.'), { status: 422 });
  const totals = { affectedProducts: report.summary.affectedProducts, affectedPriceRows: report.summary.affectedPriceRows, potentialStockShortfall: report.summary.potentialLoss, affectedStockCostValue: report.summary.affectedStockCostValue, recordedGrossShortfall: report.realised.recordedLoss, estimatedGrossShortfall: report.realised.estimatedLoss, unknownCostLines: report.realised.unknownCostLines };
  const stamp = signBookStamp({ shopId: shop._id, shopName: shop.name, key: 'price-review', title: 'Product price review', from: report.window.start, to: report.window.end, generatedAt: report.generatedAt, totals, currency: report.currency });
  const verifyUrl = bookVerifyUrl(stamp.token);
  // Create before streaming: a QR failure must never produce an unverified export.
  const qr = QRCode.create(verifyUrl, { errorCorrectionLevel: 'L' });
  const pdf = new PDFDocument({ size: 'A4', margins: { top: 40, left: 40, right: 40, bottom: 82 }, bufferPages: true, info: { Title: 'DuQana product price review', Author: sanitize(shop.name) } });
  pdf.registerFont('Report', fileURLToPath(new URL('../assets/fonts/DejaVuSans-Latin.ttf', import.meta.url)));
  pdf.font('Report');
  const chunks = [];
  const output = new Promise((resolve, reject) => { pdf.on('data', c => chunks.push(c)); pdf.on('end', () => resolve(Buffer.concat(chunks))); pdf.on('error', reject); });
  const left = 40, width = 515, bottom = 754;
  const amount = n => typeof n === 'number' && Number.isFinite(n) ? `${report.currency} ${n.toLocaleString('en-KE', { maximumFractionDigits: 2 })}` : 'Unknown / excluded';
  const clean = value => String(value ?? '').split('\n').map(sanitize).join('\n');
  const header = () => {
    pdf.font('Report').fontSize(10).fillColor('#0f766e').text('DuQana | Product price review', left, 35, { width, lineBreak: false });
    pdf.fontSize(8).fillColor('#64748b').text(`Document ${stamp.documentId}`, left, 53, { width, lineBreak: false });
    pdf.moveTo(left, 73).lineTo(left + width, 73).strokeColor('#e2e8f0').stroke();
    pdf.x = left; pdf.y = 90;
  };
  pdf.on('pageAdded', header);
  const ensure = height => {
    if (pdf.y + height <= bottom) return false;
    pdf.addPage();
    return true;
  };
  const paragraph = (text, size = 10, color = '#334155', after = 7) => {
    pdf.font('Report').fontSize(size);
    const value = clean(text);
    const height = pdf.heightOfString(value, { width, lineGap: 3 });
    // Long legacy values may span a page; PDFKit wraps them within the page
    // margins and pageAdded repeats the report header without clipping text.
    ensure(Math.min(height + after, bottom - 90));
    pdf.font('Report').fontSize(size).fillColor(color).text(value, left, pdf.y, { width, lineGap: 3 });
    pdf.moveDown(0); pdf.y += after;
  };

  paragraph('Product price review', 22, '#0f766e', 8);
  paragraph(shop.name, 13, '#0f172a', 8);
  paragraph(`Generated ${dateLabel(report.generatedAt)}\nSales window: ${report.window.start.slice(0, 10)} to ${report.window.end.slice(0, 10)}`, 9, '#64748b', 16);
  paragraph(`Products with price anomalies (${report.items.length})`, 14, '#0f172a', 8);
  paragraph('Review these entries before changing prices. Free items, flexible prices and promotions may be intentional.', 9, '#64748b', 16);
  if (!report.items.length) paragraph('No current product price anomalies found.', 11, '#0f766e', 16);

  report.items.forEach((row, index) => {
    const segments = [
      [`${index + 1}. ${row.name}${row.variantName ? ` / ${row.variantName}` : ''}`, 12, '#0f172a', 5],
      [row.issues.map(issue => labels[issue] ?? issue).join(' | '), 9, '#92400e', 7],
      [`Selling price: ${amount(row.sellingPrice)}   |   Purchase cost: ${amount(row.costPrice)}\nPer ${row.unitOfMeasure ?? 'unit'}   |   Stock: ${row.stockKnown === false ? 'Unknown / excluded' : row.stockQuantity}`, 10, '#334155', 5],
      [`Shortfall per unit: ${amount(row.unitShortfall)}   |   Potential stock shortfall: ${amount(row.potentialLoss)}`, 10, '#334155', 5],
      ...(row.productType === 'bundle' ? [['Bundle stock is shared with its component products; excluded from stock totals.', 9, '#64748b', 5]] : []),
      ...(row.flexible ? [[`Flexible price minimum: ${amount(row.minPrice)}. Actual sale prices may differ.`, 9, '#64748b', 5]] : []),
      [row.lastChange ? `${sourceLabel(row.lastChange.source)} by ${row.lastChange.actorName ?? 'name unavailable'} | ${dateLabel(row.lastChange.createdAt)}` : 'Price history was not recorded before tracking began.', 8, '#64748b', 10],
    ];
    const height = segments.reduce((sum, [text, size, , after]) => {
      pdf.font('Report').fontSize(size);
      return sum + pdf.heightOfString(clean(text), { width, lineGap: 3 }) + after;
    }, 14);
    ensure(Math.min(height, bottom - 90));
    segments.forEach(segment => paragraph(...segment));
    ensure(12);
    pdf.moveTo(left, pdf.y).lineTo(left + width, pdf.y).strokeColor('#e2e8f0').stroke();
    pdf.y += 14;
  });

  if (report.realised.products.length) {
    ensure(95);
    paragraph('Past sales below cost', 14, '#0f172a', 7);
    paragraph(`Largest shortfalls in the last ${report.window.days} days. Up to 10 product or variant groups, including prices that have since been corrected. Summary totals cover all qualifying sale lines.`, 9, '#64748b', 10);
    for (const row of report.realised.products) paragraph(`${row.name ?? 'Product'}${row.variantName ? ` / ${row.variantName}` : ''}: ${amount(row.loss)}${row.estimated ? ' (includes estimated costs)' : ''}`, 10, '#334155', 8);
  }

  // Explanations precede the final totals rather than burying the products.
  ensure(90);
  paragraph('About these figures', 11, '#0f172a', 6);
  paragraph(report.notes, 8, '#64748b', 6);
  paragraph('Saved purchase costs are weighted averages. Estimated costs are separate from recorded costs. The last recorded editor is not proof of who caused a shortfall. This is not an independent audit.', 8, '#64748b', 14);

  const summaryHeight = 232;
  const newPage = ensure(summaryHeight + 12);
  // On a short final page, align the closing summary toward the bottom. If
  // it needs its own page, start below the repeated header instead.
  const top = newPage ? pdf.y : Math.max(pdf.y, bottom - summaryHeight);
  pdf.save().roundedRect(left, top, width, summaryHeight, 8).fill('#f1f5f9').restore();
  pdf.font('Report').fontSize(15).fillColor('#0f172a').text('Summary', left + 14, top + 14, { width: 295 });
  const summaryRows = [
    ['Products affected', String(totals.affectedProducts)],
    ['Product / variant anomalies', String(totals.affectedPriceRows)],
    ['Potential stock shortfall', amount(totals.potentialStockShortfall)],
    ['Affected stock at cost', amount(totals.affectedStockCostValue)],
    [`Recorded shortfall (${report.window.days} days)`, amount(totals.recordedGrossShortfall)],
    ['Estimated sales shortfall', amount(totals.estimatedGrossShortfall)],
    ['Sales lines with unknown costs', String(totals.unknownCostLines)],
  ];
  summaryRows.forEach(([label, value], index) => {
    const y = top + 49 + index * 22;
    pdf.fontSize(8).fillColor('#475569').text(label, left + 14, y, { width: 190, lineBreak: false });
    pdf.fontSize(9).fillColor('#0f172a').text(value, left + 203, y - 1, { width: 108, align: 'right', lineBreak: false });
  });
  pdf.fontSize(7).fillColor('#64748b').text('Stock exposure is not loss already made. Recorded sales shortfall is not net business loss.', left + 14, top + 207, { width: 300, lineGap: 2 });
  const quiet = 4, cells = qr.modules.size + quiet * 2, step = 132 / cells;
  const qrX = left + 347, qrY = top + 14;
  pdf.save().fillColor('#ffffff').rect(qrX, qrY, 132, 132).fill();
  pdf.fillColor('#000000');
  for (let r = 0; r < qr.modules.size; r++) for (let c = 0; c < qr.modules.size; c++) if (qr.modules.get(r, c)) pdf.rect(qrX + (c + quiet) * step, qrY + (r + quiet) * step, step, step).fill();
  pdf.restore();
  pdf.link(qrX, qrY, 132, 132, verifyUrl);
  pdf.fontSize(8).fillColor('#0f766e').text('Scan to verify summary', qrX - 3, qrY + 142, { width: 138, align: 'center' });
  pdf.fontSize(7).fillColor('#64748b').text(`Document ${stamp.documentId}\nCompare these totals with DuQana's signed summary.`, qrX - 4, qrY + 159, { width: 140, align: 'center', lineGap: 3 });

  const range = pdf.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    pdf.switchToPage(i);
    // Footer is outside the body margin. Temporarily widen that margin so
    // PDFKit does not create an extra page while drawing page numbers.
    const margin = pdf.page.margins.bottom;
    pdf.page.margins.bottom = 0;
    pdf.font('Report').fontSize(8).fillColor('#64748b').text(`DuQana | ${stamp.documentId} | Page ${i + 1} of ${range.count}`, left, 790, { width, lineBreak: false });
    pdf.page.margins.bottom = margin;
  }
  pdf.end();
  return output;
}

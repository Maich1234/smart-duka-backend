import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { signBookStamp, bookVerifyUrl } from '../utils/bookStamp.js';
import { sanitize } from './books/renderers/pdf.js';

const labels = { zero_or_missing_price: 'Selling price zero, negative or missing', below_cost: 'Selling below cost', minimum_below_cost: 'Allowed minimum below cost', cost_not_set: 'Cost not set', missing_variants: 'No variants' };
/** A readable register, with variable-height rows and a mandatory verification QR. */
export async function renderPriceHealthPdf(report, shop) {
  const totals = { affectedProducts: report.summary.affectedProducts, affectedPriceRows: report.summary.affectedPriceRows, potentialStockShortfall: report.summary.potentialLoss, affectedStockCostValue: report.summary.affectedStockCostValue, recordedGrossShortfall: report.realised.recordedLoss, estimatedGrossShortfall: report.realised.estimatedLoss, unknownCostLines: report.realised.unknownCostLines };
  const stamp = signBookStamp({ shopId: shop._id, shopName: shop.name, key: 'price-review', title: 'Product price review', from: report.window.start, to: report.window.end, generatedAt: report.generatedAt, totals, currency: report.currency });
  // Generate before streaming. A QR error must not produce an unverified PDF.
  const qr = QRCode.create(bookVerifyUrl(stamp.token), { errorCorrectionLevel: 'L' });
  const pdf = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: 'DuQana product price review', Author: sanitize(shop.name) } });
  pdf.registerFont('Report', fileURLToPath(new URL('../assets/fonts/DejaVuSans-Latin.ttf', import.meta.url)));
  pdf.font('Report');
  const chunks = []; const output = new Promise((resolve, reject) => { pdf.on('data', c => chunks.push(c)); pdf.on('end', () => resolve(Buffer.concat(chunks))); pdf.on('error', reject); });
  const currency = report.currency;
  const amount = n => typeof n === 'number' && Number.isFinite(n) ? `${currency} ${n.toLocaleString('en-KE', { maximumFractionDigits: 2 })}` : 'Unknown / excluded';
  const line = (text, size = 10, color = '#334155') => { pdf.font('Report').fontSize(size).fillColor(color); pdf.text(text.split('\n').map(sanitize).join('\n'), { width: 515, lineGap: 3 }); pdf.moveDown(0.45); };
  const ensure = h => { if (pdf.y + h > 760) pdf.addPage(); };
  line('DuQana | Product price review', 21, '#0f766e');
  line(shop.name, 14); line(`Generated: ${report.generatedAt}. Sales window: ${report.window.start.slice(0, 10)} to ${report.window.end.slice(0, 10)}.`, 9);
  const names = ['Products affected', 'Product/variant alerts', 'Potential stock shortfall', 'Affected stock cost value', 'Recorded gross shortfall', 'Estimated gross shortfall', 'Sales lines with unknown costs'];
  Object.entries(totals).forEach(([key, value], index) => line(`${names[index]}: ${/Products|Rows|Lines/.test(key) ? value : amount(value)}`, 11));
  line(report.notes, 9); line('Saved costs use weighted-average purchases. Historical estimated costs are reported separately. Pricing history identifies recorded edits, not responsibility for losses.', 9);
  ensure(210);
  const y = pdf.y; const quiet = 4, cells = qr.modules.size + quiet * 2, step = Math.min(160 / cells, 3);
  pdf.save().fillColor('#ffffff').rect(40, y, cells * step, cells * step).fill();
  pdf.fillColor('#000000'); for (let r = 0; r < qr.modules.size; r++) for (let c = 0; c < qr.modules.size; c++) if (qr.modules.get(r, c)) pdf.rect(40 + (c + quiet) * step, y + (r + quiet) * step, step, step).fill(); pdf.restore();
  pdf.fontSize(10).fillColor('#334155').text(`Scan to verify signed summary\nDocument ${stamp.documentId}\nCompare figures with the PDF.\nThis is not an independent audit.`, 215, y + 20, { width: 325 });
  pdf.link(40, y, cells * step, cells * step, bookVerifyUrl(stamp.token)); pdf.x = 40; pdf.y = y + cells * step + 18;
  line(`Current price alerts (${report.items.length})`, 15, '#0f766e');
  if (!report.items.length) line('No current price issues found.');
  for (const row of report.items) {
    const title = `${row.name}${row.variantName ? ` / ${row.variantName}` : ''}`;
    const text = [title, row.issues.map(i => labels[i] ?? i).join('; '), `Sell: ${amount(row.sellingPrice)} | Cost: ${amount(row.costPrice)} | Stock: ${row.stockQuantity} ${row.unitOfMeasure ?? 'unit'}`, `Shortfall per unit: ${amount(row.unitShortfall)} | Potential: ${amount(row.potentialLoss)}`, row.flexible ? `Flexible price minimum: ${amount(row.minPrice)}. Actual prices may differ.` : '', row.lastChange ? `Last pricing record: ${row.lastChange.actorName ?? 'Name unavailable'}, ${row.lastChange.source}, ${new Date(row.lastChange.createdAt).toISOString()}` : 'Price history: not recorded before tracking began.'].filter(Boolean).join('\n');
    pdf.font('Report').fontSize(10); const h = pdf.heightOfString(text.split('\n').map(sanitize).join('\n'), { width: 515, lineGap: 3 }) + 24;
    ensure(h); line(text); pdf.moveTo(40, pdf.y).lineTo(555, pdf.y).strokeColor('#e2e8f0').stroke(); pdf.moveDown();
  }
  ensure(70); line('Largest historical sales shortfalls', 15, '#0f766e'); line('Up to 10 groups, including prices that have since been corrected. Totals on page 1 cover all qualifying sale lines.', 9);
  for (const row of report.realised.products) { ensure(50); line(`${row.name ?? 'Product'}${row.variantName ? ` / ${row.variantName}` : ''}: ${amount(row.loss)}${row.estimated ? ' (includes estimated costs)' : ''}`); }
  const range = pdf.bufferedPageRange();
  for (let i = 0; i < range.count; i++) { pdf.switchToPage(i); pdf.fontSize(8).fillColor('#64748b').text(`DuQana | ${stamp.documentId} | Page ${i + 1} of ${range.count}`, 40, 780, { width: 515, lineBreak: false }); }
  pdf.end(); return output;
}

import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

/**
 * PDF renderer. Consumes any BookDocument.
 *
 * pdfkit rather than headless Chrome: this runs in a Vercel serverless
 * function, and shipping a browser to render a table would dominate both the
 * bundle and the cold start.
 *
 * Uses the built-in Helvetica rather than an embedded font. That keeps the
 * bundle small, at the cost of WinAnsi-only glyphs — hence sanitize() below,
 * which is not cosmetic: pdfkit throws on characters the font can't encode,
 * and a shop named with anything outside Latin-1 would otherwise fail to
 * produce a PDF at all.
 */

const TEAL = '#0F766E';
const INK = '#0F172A';
const MUTED = '#64748B';
const RULE = '#CBD5E1';

const MARGIN = 40;
const ROW_HEIGHT = 18;
const FONT_SIZE = 8.5;

/** Replaces glyphs the standard fonts can't encode, rather than throwing. */
function sanitize(value) {
  return String(value ?? '')
    .replace(/[–—]/g, '-')
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/×/g, 'x')
    .replace(/[^\x20-\xFF]/g, '');
}

const fmtMoney = (v, currency) =>
  v === '' || v === null || v === undefined || Number.isNaN(Number(v))
    ? ''
    : `${currency} ${Number(v).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtDate = (v) => {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime())
    ? sanitize(v)
    : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

function cellText(row, col, currency) {
  const raw = row[col.key];
  if (col.type === 'money') return fmtMoney(raw, currency);
  if (col.type === 'date') return fmtDate(raw);
  return sanitize(raw);
}

/**
 * Column widths proportional to type, scaled to the page. Money and date
 * columns need a predictable amount; text takes what's left.
 */
function layoutColumns(columns, available) {
  const weight = (c) => (c.type === 'money' ? 1.15 : c.type === 'date' ? 0.95 : c.type === 'number' ? 0.55 : 1.6);
  const total = columns.reduce((s, c) => s + weight(c), 0);
  return columns.map((c) => (weight(c) / total) * available);
}

export function renderPdf(doc) {
  return new Promise((resolve, reject) => {
    // Landscape for wide registers, portrait for the narrow P&L.
    const landscape = doc.columns.length > 4;
    const pdf = new PDFDocument({
      size: 'A4',
      layout: landscape ? 'landscape' : 'portrait',
      margin: MARGIN,
      // Required for the page-number pass at the end, which can only run
      // once the total page count is known.
      bufferPages: true,
      info: {
        Title: `${doc.title} — ${doc.period.label}`,
        Author: sanitize(doc.shop.name),
        Creator: 'Dukana',
      },
    });

    const chunks = [];
    pdf.on('data', (c) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    const pageWidth = pdf.page.width - MARGIN * 2;
    const widths = layoutColumns(doc.columns, pageWidth);
    const currency = doc.shop.currency;

    const drawHeader = () => {
      pdf.font('Helvetica-Bold').fontSize(16).fillColor(INK).text(sanitize(doc.title), MARGIN, MARGIN);
      pdf.font('Helvetica').fontSize(10).fillColor(MUTED)
        .text(sanitize(doc.shop.name), { continued: false })
        .text(`${sanitize(doc.period.label)}  ·  all figures in ${currency}`);
      if (doc.meta.estimated) {
        pdf.fontSize(8.5).fillColor('#B45309')
          .text('Contains estimated figures - see the notes at the end.');
      }
      pdf.moveDown(0.6);
    };

    const drawColumnHeads = () => {
      const y = pdf.y;
      pdf.rect(MARGIN, y - 2, pageWidth, ROW_HEIGHT).fill(TEAL);
      pdf.font('Helvetica-Bold').fontSize(FONT_SIZE).fillColor('#FFFFFF');
      let x = MARGIN;
      doc.columns.forEach((col, i) => {
        pdf.text(sanitize(col.label), x + 4, y + 3, {
          width: widths[i] - 8,
          align: col.align,
          lineBreak: false,
        });
        x += widths[i];
      });
      pdf.y = y + ROW_HEIGHT + 2;
      pdf.fillColor(INK);
    };

    const bottomLimit = () => pdf.page.height - MARGIN - 28;

    const ensureRoom = (needed = ROW_HEIGHT) => {
      if (pdf.y + needed > bottomLimit()) {
        pdf.addPage();
        drawColumnHeads();
      }
    };

    /**
     * Cuts a string to fit its column, measuring in the font that will draw
     * it. pdfkit's own `ellipsis` proved unreliable here — a long expense
     * description wrapped to a second line and overlapped the row beneath,
     * which on a financial document reads as a corrupted figure. Truncating
     * ourselves keeps every row exactly one line tall.
     */
    const fit = (text, width) => {
      if (!text) return '';
      if (pdf.widthOfString(text) <= width) return text;
      let lo = 0;
      let hi = text.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (pdf.widthOfString(text.slice(0, mid) + '...') <= width) lo = mid;
        else hi = mid - 1;
      }
      return text.slice(0, lo).trimEnd() + '...';
    };

    const drawRow = (values, { bold = false, rule = false } = {}) => {
      ensureRoom();
      const y = pdf.y;
      if (rule) {
        pdf.moveTo(MARGIN, y - 2).lineTo(MARGIN + pageWidth, y - 2).lineWidth(0.5).strokeColor(RULE).stroke();
      }
      pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(FONT_SIZE).fillColor(INK);
      let x = MARGIN;
      doc.columns.forEach((col, i) => {
        const inner = widths[i] - 8;
        pdf.text(fit(values[i] ?? '', inner), x + 4, y + 2, {
          width: inner,
          align: col.align,
          lineBreak: false,
        });
        x += widths[i];
      });
      pdf.y = y + ROW_HEIGHT;
    };

    drawHeader();
    drawColumnHeads();

    for (const section of doc.sections) {
      if (section.label) {
        ensureRoom(ROW_HEIGHT + 4);
        const y = pdf.y;
        pdf.rect(MARGIN, y - 1, pageWidth, ROW_HEIGHT).fill('#F1F5F9');
        pdf.font('Helvetica-Bold').fontSize(FONT_SIZE + 0.5).fillColor(INK)
          .text(sanitize(section.label), MARGIN + 4, y + 3, { width: pageWidth - 8, lineBreak: false });
        pdf.y = y + ROW_HEIGHT + 2;
      }

      for (const row of section.rows) {
        drawRow(doc.columns.map((c) => cellText(row, c, currency)));
      }

      if (section.subtotals && Object.keys(section.subtotals).length > 0) {
        drawRow(
          doc.columns.map((c, i) =>
            section.subtotals[c.key] !== undefined
              ? (c.type === 'money' ? fmtMoney(section.subtotals[c.key], currency) : String(section.subtotals[c.key]))
              : (i === 0 ? 'Subtotal' : '')
          ),
          { bold: true, rule: true }
        );
      }
    }

    if (Object.keys(doc.totals).length > 0) {
      pdf.moveDown(0.8);
      ensureRoom(ROW_HEIGHT * (Object.keys(doc.totals).length + 1));
      pdf.font('Helvetica-Bold').fontSize(10).fillColor(INK).text('Totals', MARGIN, pdf.y);
      pdf.moveDown(0.3);
      for (const [k, v] of Object.entries(doc.totals)) {
        const label = k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
        const isCount = /^(sales|purchases|expenses)$/i.test(k);
        const y = pdf.y;
        pdf.font('Helvetica').fontSize(FONT_SIZE + 0.5).fillColor(MUTED)
          .text(sanitize(label), MARGIN, y, { width: pageWidth * 0.5, lineBreak: false });
        pdf.font('Helvetica-Bold').fillColor(INK)
          .text(isCount ? String(v) : fmtMoney(v, currency), MARGIN, y, { width: pageWidth, align: 'right', lineBreak: false });
        pdf.y = y + 14;
      }
    }

    // ── Authenticity stamp ──────────────────────────────────────────────
    // Placed before the notes so it reads as part of the document rather than
    // an afterthought, and drawn as rectangles because pdfkit has no SVG.
    if (doc.stamp) {
      // 110pt is not decorative. The signed token makes an 81-module QR, so
      // at the 62pt this started as, each module printed at ~0.26mm — well
      // under the ~0.4mm a phone camera needs, and the code simply would not
      // scan off paper. At 110pt it lands at ~0.46mm.
      const QR_SIZE = 110;
      const stampHeight = QR_SIZE + 34;
      if (pdf.y + stampHeight > bottomLimit()) pdf.addPage();
      pdf.moveDown(0.8);

      const top = pdf.y;
      const boxWidth = Math.min(pageWidth, 400);
      pdf.rect(MARGIN, top, boxWidth, stampHeight - 8)
        .lineWidth(0.8).strokeColor(TEAL).stroke();

      const qrSize = QR_SIZE;
      const qrX = MARGIN + 10;
      const qrY = top + 10;
      try {
        const { modules } = QRCode.create(doc.stamp.verifyUrl, { errorCorrectionLevel: 'M' });
        const count = modules.size;
        const quiet = 2;
        const scale = qrSize / (count + quiet * 2);
        pdf.rect(qrX, qrY, qrSize, qrSize).fill('#FFFFFF');
        pdf.fillColor('#000000');
        for (let row = 0; row < count; row++) {
          let col = 0;
          while (col < count) {
            if (!modules.data[row * count + col]) { col++; continue; }
            const start = col;
            while (col < count && modules.data[row * count + col]) col++;
            pdf.rect(
              qrX + (start + quiet) * scale,
              qrY + (row + quiet) * scale,
              (col - start) * scale,
              scale
            ).fill();
          }
        }
      } catch {
        // A missing QR must not cost anyone their document.
      }

      const textX = qrX + qrSize + 12;
      const textWidth = boxWidth - (qrSize + 34);
      pdf.font('Helvetica-Bold').fontSize(8).fillColor(TEAL)
        .text('Verified by Dukana', textX, top + 12, { width: textWidth, lineBreak: false });
      pdf.font('Helvetica').fontSize(6.5).fillColor(MUTED)
        .text(
          'Scan to confirm this document came from Dukana and has not been altered. This is not an audit or an accountant\u2019s opinion.',
          textX, top + 24, { width: textWidth }
        );
      pdf.font('Helvetica-Bold').fontSize(7.5).fillColor(INK)
        .text(`Document ${doc.stamp.documentId}`, textX, top + 74, { width: textWidth, lineBreak: false });
      pdf.font('Helvetica').fontSize(6.5).fillColor(MUTED)
        .text(
          `Generated ${new Date(doc.meta.generatedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
          textX, top + 87, { width: textWidth, lineBreak: false }
        );

      pdf.y = top + stampHeight;
    }

    if (doc.footnotes.length > 0) {
      pdf.moveDown(0.8);
      pdf.font('Helvetica-Bold').fontSize(9).fillColor(INK).text('Notes', MARGIN, pdf.y);
      pdf.moveDown(0.2);
      pdf.font('Helvetica').fontSize(7.5).fillColor(MUTED);
      for (const note of doc.footnotes) {
        if (pdf.y + 22 > bottomLimit()) pdf.addPage();
        pdf.text(`- ${sanitize(note)}`, MARGIN, pdf.y, { width: pageWidth });
        pdf.moveDown(0.2);
      }
    }

    // Page numbers last, once the total is known.
    //
    // The bottom margin is zeroed around each write: text placed below the
    // margin boundary makes pdfkit start a fresh page, so stamping a footer
    // in the margin silently appended one blank page per real page — and the
    // footer then appeared at the top of it.
    const range = pdf.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      pdf.switchToPage(i);
      const bottom = pdf.page.margins.bottom;
      pdf.page.margins.bottom = 0;
      pdf.font('Helvetica').fontSize(7).fillColor(MUTED).text(
        `${sanitize(doc.shop.name)}  ·  ${sanitize(doc.title)}  ·  Page ${i - range.start + 1} of ${range.count}`,
        MARGIN,
        pdf.page.height - MARGIN + 8,
        { width: pdf.page.width - MARGIN * 2, align: 'center', lineBreak: false }
      );
      pdf.page.margins.bottom = bottom;
    }

    pdf.end();
  });
}

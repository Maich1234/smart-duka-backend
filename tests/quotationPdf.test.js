import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { renderQuotationPdf } from '../src/services/quotationPdfService.js';

/**
 * renderQuotationPdf renders a quotation into one of three visually distinct
 * PDF templates. No database, no Express — pure function in, Buffer out.
 * Most of these tests only check that each template produces a real PDF
 * buffer and that an unknown template name is rejected; visual layout isn't
 * asserted (that would mean parsing PDF content streams, which isn't worth
 * it for that). One test below does decode content streams, specifically to
 * verify the encoding-safety fix — see the comment on it for why.
 */

/**
 * Pulls every FlateDecode content stream out of a raw PDF buffer, inflates
 * it, and returns the concatenated text plus every hex-string operand
 * (`<...>` in a Tj/TJ show-text op) found in it.
 *
 * This is how pdfkit's standard-font encoder (AFMFont.encodeText in
 * node_modules/pdfkit/js/pdfkit.js) actually writes drawn text: each
 * character's codepoint is written as its own hex digits, with no fixed
 * width. For any codepoint pdfkit's WIN_ANSI_MAP doesn't remap (i.e.
 * anything outside Latin-1), the raw codepoint goes in unchanged — and a
 * codepoint above 0xFF needs 3+ hex digits, breaking the 2-digits-per-byte
 * pairing every PDF reader assumes for a hex string. That desyncs and
 * garbles the rest of that string. sanitize() (src/services/books/renderers/pdf.js)
 * strips such characters before they reach pdfkit, so every hex string
 * pdfkit emits should always have an even digit count. An odd one is
 * concrete, structural proof that an unsanitized character reached the font
 * encoder — i.e. that a sanitize() call is missing somewhere.
 */
function decodePdfTextStreams(buffer) {
  let cursor = 0;
  let inflated = '';
  for (;;) {
    const start = buffer.indexOf('stream\n', cursor);
    if (start === -1) break;
    const dataStart = start + 'stream\n'.length;
    const end = buffer.indexOf('endstream', dataStart);
    try {
      inflated += zlib.inflateSync(buffer.subarray(dataStart, end)).toString('latin1');
    } catch {
      // Not a flate-compressed stream (e.g. an embedded font/object) — irrelevant here.
    }
    cursor = end + 'endstream'.length;
  }
  const hexStrings = [...inflated.matchAll(/<([0-9a-fA-F]+)>/g)].map((m) => m[1]);
  const drawnText = hexStrings
    .map((h) => {
      const bytes = [];
      for (let i = 0; i + 1 < h.length; i += 2) bytes.push(parseInt(h.slice(i, i + 2), 16));
      return String.fromCharCode(...bytes);
    })
    .join('');
  return { hexStrings, drawnText };
}

const sample = {
  quoteNumber: 'QUO-2609-00001',
  shopName: 'Test Plumbing Co',
  shopPhone: '0712345678',
  shopAddress: '123 Moi Avenue, Nairobi',
  currency: 'KES',
  customerSnapshot: { name: 'Jane Doe', phone: '0700000000', email: '' },
  items: [{ name: 'Pipe repair', description: '', quantity: 1, unitPrice: 2500, subtotal: 2500 }],
  subtotal: 2500,
  taxRate: 0,
  taxAmount: 0,
  total: 2500,
  notes: '',
  validUntil: new Date('2026-12-01'),
  createdAt: new Date('2026-09-16'),
};

for (const template of ['classic', 'modern', 'minimal']) {
  test(`renderQuotationPdf produces a valid PDF buffer for the ${template} template`, async () => {
    const buffer = await renderQuotationPdf(sample, template);
    assert.equal(Buffer.isBuffer(buffer), true);
    assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
  });
}

test('renderQuotationPdf rejects an unknown template name', async () => {
  await assert.rejects(() => renderQuotationPdf(sample, 'nonexistent'));
});

for (const template of ['classic', 'modern', 'minimal']) {
  test(`renderQuotationPdf draws shopAddress in the ${template} template when present`, async () => {
    const buffer = await renderQuotationPdf(sample, template);
    const { drawnText } = decodePdfTextStreams(buffer);
    assert.match(drawnText, /123 Moi Avenue, Nairobi/);
  });

  test(`renderQuotationPdf omits shopAddress in the ${template} template when absent`, async () => {
    const { shopAddress, ...withoutAddress } = sample;
    const buffer = await renderQuotationPdf(withoutAddress, template);
    const { drawnText } = decodePdfTextStreams(buffer);
    assert.doesNotMatch(drawnText, /Moi Avenue/);
  });
}

test('renderQuotationPdf sanitizes non-Latin-1 script in every free-text field before drawing', async () => {
  const arabicName = 'Ahmed مصطفى Traders'; // customer name with Arabic script mixed in
  const cjkItemName = '修理 Repair job'; // item.name
  const cjkDescription = 'Includes 零件 parts'; // item.description
  const emojiNotes = 'Thanks for your business 😀'; // notes
  const greekAddress = 'Nairobi Ω Road'; // shopAddress with Greek script mixed in

  const data = {
    ...sample,
    shopAddress: greekAddress,
    customerSnapshot: { ...sample.customerSnapshot, name: arabicName },
    items: [{ name: cjkItemName, description: cjkDescription, quantity: 1, unitPrice: 2500, subtotal: 2500 }],
    notes: emojiNotes,
  };

  for (const template of ['classic', 'modern', 'minimal']) {
    const buffer = await renderQuotationPdf(data, template);
    assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');

    const { hexStrings, drawnText } = decodePdfTextStreams(buffer);
    const oddLengthHexStrings = hexStrings.filter((h) => h.length % 2 !== 0);
    assert.deepEqual(
      oddLengthHexStrings,
      [],
      `${template}: an odd-length hex string means an unsanitized non-Latin-1 character reached pdfkit's font encoder, corrupting the drawn text`
    );

    // The Latin-1 portions of each field must still render intact around
    // where the stripped script was.
    assert.match(drawnText, /Ahmed\s*Traders/, `${template}: customer name`);
    assert.match(drawnText, /Repair job/, `${template}: item name`);
    assert.match(drawnText, /Includes\s*parts/, `${template}: item description`);
    assert.match(drawnText, /Thanks for your business/, `${template}: notes`);
    assert.match(drawnText, /Nairobi\s*Road/, `${template}: shop address`);
  }
});

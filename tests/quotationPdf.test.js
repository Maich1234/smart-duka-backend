import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderQuotationPdf } from '../src/services/quotationPdfService.js';

/**
 * renderQuotationPdf renders a quotation into one of three visually distinct
 * PDF templates. No database, no Express — pure function in, Buffer out.
 * These tests only check that each template produces a real PDF buffer and
 * that an unknown template name is rejected; visual layout isn't asserted
 * (that would mean parsing PDF content streams, which isn't worth it here).
 */

const sample = {
  quoteNumber: 'QUO-2609-00001',
  shopName: 'Test Plumbing Co',
  shopPhone: '0712345678',
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

/**
 * CSV renderer. Consumes any BookDocument.
 *
 * Includes a short header block (shop, book, period) above the table, because
 * an exported file has to be self-describing once it's detached from the
 * screen it came from — six months later "cashbook.csv" in a Downloads folder
 * should still say whose shop and which month.
 */

/**
 * Excel decides a leading =, +, - or @ starts a formula, so an unescaped
 * field can execute when the file is opened. Prefixing with a quote neuters
 * it. Shop names, expense descriptions and supplier names are all
 * user-supplied and all end up in these files.
 */
function escapeCell(value) {
  if (value === null || value === undefined) return '';
  let s = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

const line = (cells) => cells.map(escapeCell).join(',');

export function renderCsv(doc) {
  const out = [];

  out.push(line([doc.title]));
  out.push(line([doc.shop.name]));
  out.push(line(['Period', doc.period.label]));
  out.push(line(['Currency', doc.shop.currency]));
  out.push(line(['Generated', new Date(doc.meta.generatedAt).toISOString().slice(0, 16).replace('T', ' ')]));
  if (doc.meta.estimated) out.push(line(['Note', 'Contains estimated figures — see notes below.']));
  if (doc.stamp) {
    out.push(line(['Document', doc.stamp.documentId]));
    out.push(line(['Verify at', doc.stamp.verifyUrl]));
  }
  out.push('');

  const keys = doc.columns.map((c) => c.key);
  const hasSectionLabels = doc.sections.some((s) => s.label);

  out.push(line([...(hasSectionLabels ? ['Section'] : []), ...doc.columns.map((c) => c.label)]));

  for (const section of doc.sections) {
    for (const row of section.rows) {
      out.push(line([...(hasSectionLabels ? [section.label ?? ''] : []), ...keys.map((k) => row[k])]));
    }
    if (section.subtotals && Object.keys(section.subtotals).length > 0) {
      out.push(line([
        ...(hasSectionLabels ? [section.label ?? ''] : []),
        ...keys.map((k, i) =>
          section.subtotals[k] !== undefined ? section.subtotals[k] : (i === 0 ? 'Subtotal' : '')
        ),
      ]));
    }
  }

  if (Object.keys(doc.totals).length > 0) {
    out.push('');
    out.push(line(['Totals']));
    for (const [k, v] of Object.entries(doc.totals)) {
      // camelCase → "Money in", so the file reads like the screen did.
      const label = k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
      out.push(line([label, v]));
    }
  }

  if (doc.footnotes.length > 0) {
    out.push('');
    out.push(line(['Notes']));
    for (const note of doc.footnotes) out.push(line([note]));
  }

  if (doc.stamp) {
    out.push('');
    out.push(line(['Verified by Dukana']));
    out.push(line(['Document', doc.stamp.documentId]));
    out.push(line(['Check at', doc.stamp.verifyUrl]));
    out.push(line(['', 'Confirms this came from Dukana and has not been altered. Not an audit.']));
  }

  // BOM so Excel opens UTF-8 correctly — without it, en dashes and the ’ in
  // the footnotes arrive as mojibake on a default Windows install.
  return '﻿' + out.join('\r\n');
}

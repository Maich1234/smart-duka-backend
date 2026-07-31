import ExcelJS from 'exceljs';

/**
 * Excel renderer. Consumes any BookDocument.
 *
 * Money is written as a real number with a currency format, not a
 * pre-formatted string — the whole reason someone asks for Excel rather than
 * a PDF is to sum a column, and text that looks like money can't be summed.
 * Dates are written as Dates for the same reason.
 */

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } };
const SECTION_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };

const moneyFormat = (currency) => `"${currency}" #,##0.00;[Red]-"${currency}" #,##0.00`;

const columnWidth = (type) => (type === 'money' ? 16 : type === 'date' ? 14 : type === 'number' ? 10 : 28);

export async function renderXlsx(doc) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Smart Duka';
  wb.created = new Date(doc.meta.generatedAt);

  const ws = wb.addWorksheet(doc.title.slice(0, 31));
  const colCount = doc.columns.length;
  const fmt = moneyFormat(doc.shop.currency);

  const titleRow = ws.addRow([doc.title]);
  titleRow.font = { bold: true, size: 16, color: { argb: 'FF0F172A' } };
  ws.mergeCells(titleRow.number, 1, titleRow.number, Math.max(colCount, 2));

  const shopRow = ws.addRow([doc.shop.name]);
  shopRow.font = { size: 11, color: { argb: 'FF64748B' } };
  ws.mergeCells(shopRow.number, 1, shopRow.number, Math.max(colCount, 2));

  const periodRow = ws.addRow([doc.period.label]);
  periodRow.font = { size: 11, color: { argb: 'FF64748B' } };
  ws.mergeCells(periodRow.number, 1, periodRow.number, Math.max(colCount, 2));

  if (doc.meta.estimated) {
    const warn = ws.addRow(['Contains estimated figures — see the notes at the end.']);
    warn.font = { size: 10, italic: true, color: { argb: 'FFB45309' } };
    ws.mergeCells(warn.number, 1, warn.number, Math.max(colCount, 2));
  }

  ws.addRow([]);

  const header = ws.addRow(doc.columns.map((c) => c.label));
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = HEADER_FILL;
    cell.alignment = { vertical: 'middle' };
  });
  // Freeze under the header so column names stay put in a long register.
  ws.views = [{ state: 'frozen', ySplit: header.number }];

  const keys = doc.columns.map((c) => c.key);

  const styleDataRow = (row) => {
    doc.columns.forEach((col, i) => {
      const cell = row.getCell(i + 1);
      if (col.type === 'money') {
        cell.numFmt = fmt;
        cell.alignment = { horizontal: 'right' };
      } else if (col.type === 'number') {
        cell.alignment = { horizontal: 'right' };
      } else if (col.type === 'date') {
        cell.numFmt = 'dd mmm yyyy';
      }
    });
  };

  for (const section of doc.sections) {
    if (section.label) {
      const label = ws.addRow([section.label]);
      label.font = { bold: true, color: { argb: 'FF0F172A' } };
      label.eachCell((cell) => { cell.fill = SECTION_FILL; });
      ws.mergeCells(label.number, 1, label.number, Math.max(colCount, 2));
    }

    for (const row of section.rows) {
      const values = keys.map((k, i) => {
        const v = row[k];
        if (v === '' || v === null || v === undefined) return null;
        if (doc.columns[i].type === 'date') return v instanceof Date ? v : new Date(v);
        return v;
      });
      styleDataRow(ws.addRow(values));
    }

    if (section.subtotals && Object.keys(section.subtotals).length > 0) {
      const values = keys.map((k, i) =>
        section.subtotals[k] !== undefined ? section.subtotals[k] : (i === 0 ? 'Subtotal' : null)
      );
      const row = ws.addRow(values);
      styleDataRow(row);
      row.font = { bold: true };
      row.eachCell((cell) => {
        cell.border = { top: { style: 'thin', color: { argb: 'FFCBD5E1' } } };
      });
    }
  }

  if (Object.keys(doc.totals).length > 0) {
    ws.addRow([]);
    const heading = ws.addRow(['Totals']);
    heading.font = { bold: true, size: 12 };
    for (const [k, v] of Object.entries(doc.totals)) {
      const label = k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
      const row = ws.addRow([label, v]);
      row.getCell(1).font = { bold: true };
      // Counts aren't money; formatting them as currency would be a lie.
      if (typeof v === 'number' && !/^(sales|purchases|expenses)$/i.test(k)) {
        row.getCell(2).numFmt = fmt;
      }
      row.getCell(2).alignment = { horizontal: 'right' };
    }
  }

  if (doc.footnotes.length > 0) {
    ws.addRow([]);
    const heading = ws.addRow(['Notes']);
    heading.font = { bold: true, size: 12 };
    for (const note of doc.footnotes) {
      const row = ws.addRow([note]);
      row.font = { size: 10, color: { argb: 'FF64748B' } };
      row.getCell(1).alignment = { wrapText: true };
      ws.mergeCells(row.number, 1, row.number, Math.max(colCount, 2));
    }
  }

  doc.columns.forEach((col, i) => {
    ws.getColumn(i + 1).width = columnWidth(col.type);
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

import * as XLSX from 'xlsx';
import { inflateRawSync } from 'node:zlib';
import mongoose from 'mongoose';
import Product from '../models/Product.js';
import { createProductSchema } from '../validations/productValidation.js';

export const MAX_ROWS = 2000;
const headers = {
  Products: ['name', 'category', 'productType', 'sellingPrice', 'costPrice', 'quantity', 'sku', 'barcode', 'unitOfMeasure', 'lowStockAlert', 'trackInventory', 'minPrice', 'maxPrice', 'allowPriceOverride', 'description', 'creditEligible'],
  Variants: ['parentSku', 'name', 'sellingPrice', 'costPrice', 'quantity', 'sku', 'barcode', 'lowStockAlert'],
  Bundles: ['parentSku', 'componentSku', 'quantity'],
};
export const importError = message => Object.assign(new Error(message), { status: 400 });

/** Validate compressed contents before SheetJS allocates XML buffers. No extraction. */
function inspectZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw importError('Invalid XLSX archive.');
  const count = buf.readUInt16LE(eocd + 10), offset = buf.readUInt32LE(eocd + 16);
  if (count > 500 || count === 0xffff || offset === 0xffffffff) throw importError('This spreadsheet is too complex. Use the DuQana template.');
  let position = offset, total = 0;
  for (let i = 0; i < count; i++) {
    if (position + 46 > eocd || buf.readUInt32LE(position) !== 0x02014b50) throw importError('Invalid XLSX directory.');
    const flags = buf.readUInt16LE(position + 8), method = buf.readUInt16LE(position + 10), compressed = buf.readUInt32LE(position + 20), size = buf.readUInt32LE(position + 24), local = buf.readUInt32LE(position + 42);
    total += size;
    if ((flags & 1) || ![0, 8].includes(method) || total > 25 * 1024 * 1024 || local + 30 > buf.length) throw importError('Spreadsheet is encrypted or exceeds the 25 MB expanded limit.');
    if (buf.readUInt32LE(local) !== 0x04034b50) throw importError('Invalid XLSX entry.');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + compressed > buf.length) throw importError('Truncated XLSX entry.');
    try {
      const bytes = method === 8 ? inflateRawSync(buf.subarray(start, start + compressed), { maxOutputLength: Math.max(1, Math.min(size, 25 * 1024 * 1024)) }) : buf.subarray(start, start + compressed);
      if (bytes.length !== size) throw Error();
    } catch { throw importError('Invalid or oversized compressed spreadsheet content.'); }
    position += 46 + buf.readUInt16LE(position + 28) + buf.readUInt16LE(position + 30) + buf.readUInt16LE(position + 32);
  }
}
export function template(format = 'xlsx') {
  const book = XLSX.utils.book_new();
  for (const [name, keys] of Object.entries(headers)) {
    const sheet = XLSX.utils.aoa_to_sheet([keys]);
    sheet['!cols'] = keys.map(() => ({ wch: 22 }));
    XLSX.utils.book_append_sheet(book, sheet, name);
  }
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['DuQana product import', 'Up to 2,000 products and 2,000 variant/component rows per file. 5 MB upload limit.'],
    ['Required', 'Products: name, category, sellingPrice, costPrice. Prices must be positive; service costs and configurable parent prices may be 0. Quantity defaults to 0.'],
    ['Example', 'Cooking oil | groceries | standard | 250 | 200 | 20 | OIL-1 | | l'],
    ['Types', 'standard, variable, weighted, refillable, service, bundle, configurable'],
    ['Optional', 'Booleans: true/false. Units: unit, kg, g, l, ml, dozen, pack, box, bag, lb, oz, m, cm, ton.'],
    ['Variants', 'For configurable products, give the parent a unique sku; add child rows on Variants using parentSku.'],
    ['Bundles', 'Use parentSku and componentSku on Bundles. Components must be existing or imported standard/weighted/refillable products.'],
    ['Variable prices', 'minPrice/maxPrice only for variable products. allowPriceOverride only for services.'],
    ['Identifiers', 'Format barcode and SKU columns as text to preserve leading zeros. No formulas, macros or passwords.'],
    ['Import', 'Adds new products only. Does not update or delete existing products. Preview all errors before saving.'],
    ['Costs', 'Keep purchase costs accurate. Below-cost prices need explicit acknowledgement in the preview.'],
  ]), 'Instructions');
  return XLSX.write(book, { type: 'buffer', bookType: format === 'xls' ? 'biff8' : 'xlsx' });
}
import { duplicateErrors } from './productDuplicates.js';
export { duplicateErrors } from './productDuplicates.js';
const norm = value => String(value ?? '').trim().toLowerCase();
export function parseSpreadsheet(buffer, existing) {
  const zip = buffer.subarray(0, 2).toString() === 'PK';
  if (zip) inspectZip(buffer);
  else if (buffer.subarray(0, 8).toString('hex') !== 'd0cf11e0a1b11ae1') throw importError('Choose an Excel .xls or .xlsx file.');
  let book;
  try { book = XLSX.read(buffer, { type: 'buffer', bookVBA: true, cellFormula: true, sheetRows: MAX_ROWS + 3 }); } catch { throw importError('Could not read the spreadsheet. Remove passwords and use the DuQana template.'); }
  if (book.vbaraw || book.Workbook?.Sheets?.some(s => s.Hidden === 2) || book.SheetNames.some(name => book.Sheets[name]['!type'] === 'macro')) throw importError('Macro-enabled or hidden executable sheets are not accepted.');
  if (!book.Sheets.Products) throw importError('A Products sheet is required. Download the template.');
  const sheets = {};
  for (const name of book.SheetNames) {
    const sheet = book.Sheets[name];
    const range = XLSX.utils.decode_range(sheet['!fullref'] ?? sheet['!ref'] ?? 'A1');
    if (range.e.r > MAX_ROWS || range.e.c > 30) throw importError(`Sheet ${name} exceeds 2,000 data rows or 31 columns.`);
    for (const [key, cell] of Object.entries(sheet)) if (!key.startsWith('!') && cell.f) throw importError(`Formula found in ${name}!${key}. Replace formulas with values.`);
    if (!Object.hasOwn(headers, name)) { if (name !== 'Instructions') throw importError(`Unknown sheet ${name}. Use the template sheets.`); continue; }
    const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: true });
    if (!grid.length) { sheets[name] = []; continue; }
    const cols = grid[0].map(v => String(v).trim());
    if (new Set(cols).size !== cols.length || cols.some(c => !headers[name].includes(c))) throw importError(`Invalid or repeated column in ${name}. Keep the template headings.`);
    sheets[name] = grid.slice(1).map((cells, i) => ({ row: i + 2, data: Object.fromEntries(cols.flatMap((c, j) => cells[j] === '' || cells[j] === null ? [] : [[c, typeof cells[j] === 'string' ? cells[j].trim() : cells[j]]])) })).filter(row => Object.keys(row.data).length);
  }
  if (!sheets.Products?.length) throw importError('Add at least one product to the Products sheet.');
  const rows = [], products = [], warnings = [], candidates = sheets.Products.map(({ data, row }) => ({ ...data, _id: new mongoose.Types.ObjectId(), _row: row }));
  const initialConflicts = duplicateErrors(candidates, existing);
  if (initialConflicts.length) return { products: [], rows: [{ row: 0, name: 'Duplicate names or identifiers', errors: initialConflicts.slice(0, 2000) }], warnings: [], canCommit: false };
  const bySku = new Map([...existing, ...candidates].filter(p => p.sku).map(p => [norm(p.sku), p]));
  for (const source of candidates) {
    const { _id, _row, ...raw } = source; const errors = [];
    if (raw.productType === 'configurable') raw.variants = (sheets.Variants ?? []).filter(v => norm(v.data.parentSku) === norm(raw.sku) && raw.sku).map(v => { const { parentSku, ...data } = v.data; return data; });
    if (raw.productType === 'bundle') raw.bundleItems = (sheets.Bundles ?? []).filter(b => norm(b.data.parentSku) === norm(raw.sku) && raw.sku).map(b => {
      const component = bySku.get(norm(b.data.componentSku));
      if (!component || !['standard', 'weighted', 'refillable'].includes(component.productType ?? 'standard')) errors.push(`Bundles row ${b.row}: component must have a known SKU and be standard, weighted or refillable.`);
      return { product: String(component?._id ?? ''), quantity: b.data.quantity };
    });
    for (const [key, max] of [['name', 160], ['category', 100], ['description', 2000], ['sku', 128], ['barcode', 128]]) if (String(raw[key] ?? '').length > max) errors.push(`${key} cannot exceed ${max} characters.`);
    for (const variant of raw.variants ?? []) for (const key of ['name', 'sku', 'barcode']) if (String(variant[key] ?? '').length > 160) errors.push(`Variant ${key} cannot exceed 160 characters.`);
    if (Object.values(raw).some(v => typeof v === 'string' && v.length > 4000)) errors.push('Text cells cannot exceed 4,000 characters.');
    const result = createProductSchema.validate(raw, { abortEarly: false, convert: true });
    errors.push(...(result.error?.details.map(d => d.message) ?? []));
    if (!result.error) { const modelError = new Product({ ...result.value, shop: new mongoose.Types.ObjectId() }).validateSync(); if (modelError) errors.push(...Object.values(modelError.errors).map(e => e.message)); }
    if (String(raw.name ?? '').length > 160 || String(raw.description ?? '').length > 2000) errors.push('Name is limited to 160 characters and description to 2,000.');
    if (!errors.length) {
      const product = { ...result.value, _id };
      product.variants = (product.variants ?? []).map(v => ({ ...v, _id: new mongoose.Types.ObjectId() }));
      products.push(product);
      for (const price of product.productType === 'configurable' ? product.variants : [product]) if (price.sellingPrice < price.costPrice || (product.minPrice != null && product.minPrice < price.costPrice)) warnings.push(`Row ${_row}, ${product.name}: selling price or allowed minimum is below cost.`);
    }
    rows.push({ row: _row, name: String(raw.name ?? '').slice(0, 160), productType: String(raw.productType ?? 'standard').slice(0, 30), sellingPrice: typeof raw.sellingPrice === 'number' ? raw.sellingPrice : String(raw.sellingPrice ?? '').slice(0, 80), costPrice: typeof raw.costPrice === 'number' ? raw.costPrice : String(raw.costPrice ?? '').slice(0, 80), quantity: typeof raw.quantity === 'number' ? raw.quantity : String(raw.quantity ?? '0').slice(0, 80), errors });
  }
  for (const name of ['Variants', 'Bundles']) for (const row of sheets[name] ?? []) if (!candidates.some(p => p.sku && norm(p.sku) === norm(row.data.parentSku) && p.productType === (name === 'Variants' ? 'configurable' : 'bundle'))) rows.push({ row: row.row, name, errors: ['parentSku must match an imported parent with the correct product type.'] });
  const duplicates = duplicateErrors(products, existing);
  if (duplicates.length) rows.push({ row: 0, name: 'Duplicate identifiers', errors: duplicates });
  return { products, rows, warnings: [...new Set(warnings)], canCommit: rows.every(r => !r.errors.length) };
}

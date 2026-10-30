import * as XLSX from 'xlsx';
import { canonicalSpreadsheetZip } from './spreadsheetArchive.js';
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

export function template(format = 'xlsx') {
  const book = XLSX.utils.book_new();
  for (const [name, keys] of Object.entries(headers)) {
    const sheet = XLSX.utils.aoa_to_sheet([keys]);
    sheet['!cols'] = keys.map(() => ({ wch: 22 }));
    // Excel must preserve leading zeros when the owner types an identifier.
    const textColumns = keys.flatMap((key, index) => ['sku', 'barcode', 'parentSku', 'componentSku'].includes(key) ? [index] : []);
    for (const c of textColumns) for (let r = 1; r <= MAX_ROWS; r++) sheet[XLSX.utils.encode_cell({ r, c })] = { t: 's', v: '', z: '@' };
    sheet['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: MAX_ROWS, c: keys.length - 1 } });
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
  return XLSX.write(book, { type: 'buffer', bookType: format === 'xls' ? 'biff8' : 'xlsx', compression: true });
}
import { duplicateErrors } from './productDuplicates.js';
export { duplicateErrors } from './productDuplicates.js';
const norm = value => String(value ?? '').trim().toLowerCase();
export function parseSpreadsheet(buffer, existing) {
  const zip = buffer.subarray(0, 2).toString() === 'PK';
  if (zip) buffer = canonicalSpreadsheetZip(buffer);
  else if (buffer.subarray(0, 8).toString('hex') !== 'd0cf11e0a1b11ae1') throw importError('This file is not a readable Excel workbook. Open the spreadsheet and save it as .xls or .xlsx; changing its name is not enough.');
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
  const bySku = new Map(), ambiguousSkus = new Set();
  for (const p of [...existing, ...candidates]) if (p.sku) { const key = norm(p.sku); if (bySku.has(key)) ambiguousSkus.add(key); bySku.set(key, p); }
  for (const source of candidates) {
    const { _id, _row, ...raw } = source; const errors = [];
    if (raw.trackInventory === undefined && ['service', 'bundle', 'configurable'].includes(raw.productType)) raw.trackInventory = false;
    const variantRows = (sheets.Variants ?? []).filter(v => norm(v.data.parentSku) === norm(raw.sku) && raw.sku);
    const bundleRows = (sheets.Bundles ?? []).filter(b => norm(b.data.parentSku) === norm(raw.sku) && raw.sku);
    if (raw.productType === 'configurable') raw.variants = variantRows.map(v => { const { parentSku, ...data } = v.data; return data; });
    if (raw.productType === 'bundle') raw.bundleItems = bundleRows.map(b => {
      const key = norm(b.data.componentSku);
      const component = ambiguousSkus.has(key) ? null : bySku.get(key);
      if (!component || !['standard', 'weighted', 'refillable'].includes(component.productType ?? 'standard')) errors.push(`Bundles row ${b.row}: component must have one unique known SKU and be standard, weighted or refillable.`);
      return { product: String(component?._id ?? ''), quantity: b.data.quantity };
    });
    for (const [key, max] of [['name', 160], ['category', 100], ['description', 2000], ['sku', 128], ['barcode', 128]]) if (String(raw[key] ?? '').length > max) errors.push(`${key} cannot exceed ${max} characters.`);
    for (const variant of raw.variants ?? []) for (const key of ['name', 'sku', 'barcode']) if (String(variant[key] ?? '').length > 160) errors.push(`Variant ${key} cannot exceed 160 characters.`);
    if (Object.values(raw).some(v => typeof v === 'string' && v.length > 4000)) errors.push('Text cells cannot exceed 4,000 characters.');
    const result = createProductSchema.validate(raw, { abortEarly: false, convert: true });
    const labels = { sellingPrice: 'Selling price (sellingPrice)', costPrice: 'Purchase cost (costPrice)', quantity: 'Stock quantity (quantity)', minPrice: 'Minimum price (minPrice)', maxPrice: 'Maximum price (maxPrice)', productType: 'Product type (productType)' };
    errors.push(...(result.error?.details.map(d => {
      const child = d.path[0] === 'variants' ? variantRows[d.path[1]] : d.path[0] === 'bundleItems' ? bundleRows[d.path[1]] : null;
      const prefix = child ? `${d.path[0] === 'variants' ? 'Variants' : 'Bundles'} row ${child.row}: ` : '';
      const field = d.path[d.path.length - 1];
      if (d.type === 'string.base' && ['sku', 'barcode'].includes(field)) return `${prefix}${field === 'sku' ? 'SKU' : 'Barcode'} must be text. Format the cell as Text and re-enter any leading zeros before uploading again.`;
      const message = d.message.replace(/^"[^"]+"/, labels[field] ?? String(field));
      return prefix + message + (d.type === 'number.base' ? '. Use a plain number without currency symbols or units.' : '');
    }) ?? []));
    if (raw.productType === 'configurable') for (const child of variantRows) if (child.data.costPrice == null) errors.push(`Variants row ${child.row}: purchase cost (costPrice) is required.`);
    if (!result.error) { const modelError = new Product({ ...result.value, shop: new mongoose.Types.ObjectId() }).validateSync(); if (modelError) errors.push(...Object.values(modelError.errors).map(e => e.message)); }
    if (String(raw.name ?? '').length > 160 || String(raw.description ?? '').length > 2000) errors.push('Name is limited to 160 characters and description to 2,000.');
    if (!errors.length) {
      const product = { ...result.value, _id };
      product.variants = (product.variants ?? []).map(v => ({ ...v, _id: new mongoose.Types.ObjectId() }));
      products.push(product);

    }
    rows.push({ row: _row, name: String(raw.name ?? '').slice(0, 160), productType: String(raw.productType ?? 'standard').slice(0, 30), sellingPrice: typeof raw.sellingPrice === 'number' ? raw.sellingPrice : String(raw.sellingPrice ?? '').slice(0, 80), costPrice: typeof raw.costPrice === 'number' ? raw.costPrice : String(raw.costPrice ?? '').slice(0, 80), quantity: typeof raw.quantity === 'number' ? raw.quantity : String(raw.quantity ?? '0').slice(0, 80), errors });
  }
  for (const name of ['Variants', 'Bundles']) for (const row of sheets[name] ?? []) if (!candidates.some(p => p.sku && norm(p.sku) === norm(row.data.parentSku) && p.productType === (name === 'Variants' ? 'configurable' : 'bundle'))) rows.push({ row: row.row, name, errors: ['parentSku must match an imported parent with the correct product type.'] });
  const catalogue = new Map([...existing, ...products].map(p => [String(p._id), p]));
  const existingIds = new Set(existing.map(p => String(p._id))), componentCosts = new Map();
  const sourceRows = new Map(candidates.map(p => [String(p._id), p._row])), previewRows = new Map(rows.map(row => [row.row, row]));
  for (const product of products) {
    const row = sourceRows.get(String(product._id)), preview = previewRows.get(row);
    if (product.productType === 'configurable') preview.details = product.variants.map(v => `${v.name}: sell ${v.sellingPrice}, cost ${v.costPrice}, stock ${v.quantity}. SKU ${v.sku || 'not set'}, barcode ${v.barcode || 'not set'}.`);
    let prices = product.productType === 'configurable' ? product.variants : [product];
    if (product.productType === 'bundle') {
      let cost = 0, known = true;
      preview.details = [];
      for (const item of product.bundleItems) {
        const component = catalogue.get(String(item.product)), value = component?.costPrice;
        preview.details.push(`${String(component?.name ?? 'Unknown component').slice(0, 160)}: ${item.quantity} units at cost ${Number.isFinite(value) ? value : 'unknown'} each.`);
        if (!Number.isFinite(value) || value <= 0) known = false;
        else cost += value * item.quantity;
        if (existingIds.has(String(item.product))) componentCosts.set(String(item.product), Number.isFinite(value) ? value : null);
      }
      if (!known) warnings.push(`Row ${row}, ${product.name}: a bundle component cost is unknown. Review before saving.`);
      preview.costPrice = known ? cost : null;
      prices = known ? [{ sellingPrice: product.sellingPrice, costPrice: cost }] : [];
    }
    for (const price of prices) {
      if (price.sellingPrice <= 0) warnings.push(`Row ${row}, ${product.name}${price.name ? ` / ${price.name}` : ''}: selling price is zero. Confirm that this item should be free.`);
      if (price.costPrice === 0 && product.productType !== 'service') warnings.push(`Row ${row}, ${product.name}${price.name ? ` / ${price.name}` : ''}: purchase cost is zero. Correct it if the cost is not known.`);
      if (price.sellingPrice < price.costPrice || (product.minPrice != null && product.minPrice < price.costPrice)) warnings.push(`Row ${row}, ${product.name}${price.name ? ` / ${price.name}` : ''}: selling price or allowed minimum is below cost.`);
    }
  }
  const duplicates = duplicateErrors(products, existing);
  if (duplicates.length) rows.push({ row: 0, name: 'Duplicate identifiers', errors: duplicates });
  return { products, rows, componentCosts: [...componentCosts].map(([product, costPrice]) => ({ product, costPrice })), warnings: [...new Set(warnings)], canCommit: rows.every(r => !r.errors.length) };
}

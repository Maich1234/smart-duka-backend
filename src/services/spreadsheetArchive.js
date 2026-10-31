import { inflateRawSync } from 'node:zlib';
import * as XLSX from 'xlsx';

const bad = message => Object.assign(new Error(message), { status: 400 });
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
const crc32 = bytes => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

/** Validate every entry, then give SheetJS a canonical archive, never attacker local headers. */
export function canonicalSpreadsheetZip(buf) {
  let end = -1;
  for (let p = buf.length - 22; p >= Math.max(0, buf.length - 65557); p--) {
    if (buf.readUInt32LE(p) === 0x06054b50 && p + 22 + buf.readUInt16LE(p + 20) === buf.length) { end = p; break; }
  }
  if (end < 0) throw bad('Invalid XLSX archive.');
  const count = buf.readUInt16LE(end + 10), directory = buf.readUInt32LE(end + 16), directorySize = buf.readUInt32LE(end + 12);
  if (!count || count > 500 || buf.readUInt16LE(end + 8) !== count || buf.readUInt16LE(end + 4) || buf.readUInt16LE(end + 6) || directory + directorySize !== end) throw bad('Invalid or unsupported XLSX directory.');
  const rebuilt = XLSX.CFB.utils.cfb_new();
  const names = new Set(), ranges = [];
  let p = directory, expanded = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || buf.readUInt32LE(p) !== 0x02014b50) throw bad('Invalid XLSX directory entry.');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16);
    const compressed = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24), local = buf.readUInt32LE(p + 42);
    const nameSize = buf.readUInt16LE(p + 28), extraSize = buf.readUInt16LE(p + 30), commentSize = buf.readUInt16LE(p + 32);
    const next = p + 46 + nameSize + extraSize + commentSize;
    expanded += size;
    if (flags & 0x2041) throw bad('This workbook is encrypted. Remove its password protection or copy the values into a fresh DuQana template.');
    if (expanded > 25 * 1024 * 1024) throw bad('The workbook expands beyond 25 MB. Split it into smaller files before uploading.');
    if (![0, 8].includes(method)) throw bad('This workbook uses unsupported compression. Save a fresh copy as XLSX and retry.');
    if (next > end || !nameSize || buf.readUInt16LE(p + 34) || local + 30 > directory) throw bad('The workbook contains a damaged entry. Save a fresh copy as XLSX and retry.');
    const nameBytes = buf.subarray(p + 46, p + 46 + nameSize), name = nameBytes.toString('utf8');
    if (name.includes('\0') || name.includes('\\') || name.startsWith('/') || name.split('/').some(part => part === '.' || part === '..') || names.has(name.toLowerCase())) throw bad('Invalid or repeated XLSX entry name.');
    names.add(name.toLowerCase());
    if (buf.readUInt32LE(local) !== 0x04034b50 || buf.readUInt16LE(local + 6) !== flags || buf.readUInt16LE(local + 8) !== method || buf.readUInt16LE(local + 26) !== nameSize) throw bad('Inconsistent XLSX entry headers.');
    const start = local + 30 + nameSize + buf.readUInt16LE(local + 28), finish = start + compressed;
    if (start > directory || finish > directory || !buf.subarray(local + 30, local + 30 + nameSize).equals(nameBytes)) throw bad('Invalid XLSX entry boundaries.');
    // Descriptor archives may keep sizes/CRC at zero in their local header.
    if (!(flags & 8) && (buf.readUInt32LE(local + 14) !== crc || buf.readUInt32LE(local + 18) !== compressed || buf.readUInt32LE(local + 22) !== size)) throw bad('Inconsistent XLSX entry sizes.');
    let bytes;
    try { bytes = method === 8 ? inflateRawSync(buf.subarray(start, finish), { maxOutputLength: Math.max(1, size) }) : buf.subarray(start, finish); }
    catch { throw bad('Invalid or oversized compressed spreadsheet content.'); }
    if (bytes.length !== size || crc32(bytes) !== crc) throw bad('Spreadsheet entry is damaged or has incorrect sizes.');
    ranges.push([local, finish]);
    if (!name.endsWith('/')) XLSX.CFB.utils.cfb_add(rebuilt, name, bytes);
    p = next;
  }
  if (p !== end) throw bad('Invalid XLSX directory length.');
  ranges.sort((a, b) => a[0] - b[0]);
  if (ranges.some((range, i) => i && range[0] < ranges[i - 1][1])) throw bad('Overlapping XLSX entries are not accepted.');
  return XLSX.CFB.write(rebuilt, { type: 'buffer', fileType: 'zip', compression: false });
}

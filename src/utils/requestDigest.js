import { createHash } from 'node:crypto';
export function requestDigest(value) {
  const normalize = v => Array.isArray(v) ? v.map(normalize) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, normalize(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

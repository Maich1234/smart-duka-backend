import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
// Static salt is fine here: the key derivation protects weak secrets; the per-field
// random IV ensures ciphertext uniqueness across identical plaintexts.
const SALT = 'smart-duka-payment-encryption-v1';

function getKey() {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) throw new Error('ENCRYPTION_KEY environment variable is not set');
  return scryptSync(secret, SALT, KEY_LENGTH);
}

/**
 * Encrypts a plaintext string with AES-256-GCM.
 * Returns a single string: "iv:authTag:ciphertext" (all base64).
 */
export function encrypt(plaintext) {
  if (!plaintext) return plaintext;
  const key = getKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const authTag = cipher.getAuthTag();

  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
}

/**
 * Decrypts a value produced by encrypt().
 * Throws if the value has been tampered with (GCM auth tag mismatch).
 */
export function decrypt(encryptedData) {
  if (!encryptedData) return encryptedData;
  const key = getKey();
  const parts = encryptedData.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted data format');

  const [ivBase64, authTagBase64, ciphertext] = parts;
  const iv = Buffer.from(ivBase64, 'base64');
  const authTag = Buffer.from(authTagBase64, 'base64');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/** Returns true if the string looks like an encrypted blob (not plaintext). */
export function isEncrypted(value) {
  if (!value) return false;
  const parts = value.split(':');
  return parts.length === 3;
}

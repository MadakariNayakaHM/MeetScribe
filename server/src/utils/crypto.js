import crypto from 'node:crypto';
import { config } from '../config.js';

// Secrets at rest (e.g. users' AI API keys): AES-256-GCM with a key derived from JWT_SECRET.
// If JWT_SECRET changes, stored secrets can no longer be decrypted and must be re-entered.
const key = crypto.createHash('sha256').update(`${config.jwtSecret}:secret-box`).digest();

export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

export function decrypt(box) {
  try {
    const [iv, tag, data] = box.split('.').map((s) => Buffer.from(s, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

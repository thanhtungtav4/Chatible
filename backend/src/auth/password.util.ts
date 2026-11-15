import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(crypto.scrypt);

/**
 * Secure password hashing using Node.js native crypto.scrypt.
 * Uses async libuv threadpool by default to avoid blocking the event loop (SEC-03).
 */
export class PasswordUtil {
  static async hash(password: string): Promise<string> {
    const salt = crypto.randomBytes(16).toString('hex');
    const derivedKey = (await scryptAsync(password, salt, 64)) as Buffer;
    return `${salt}:${derivedKey.toString('hex')}`;
  }

  static async verify(password: string, storedHash: string): Promise<boolean> {
    const [salt, key] = storedHash.split(':');
    if (!salt || !key) return false;

    const keyBuffer = Buffer.from(key, 'hex');
    try {
      const derivedKey = (await scryptAsync(password, salt, 64)) as Buffer;
      return keyBuffer.byteLength === derivedKey.byteLength && crypto.timingSafeEqual(keyBuffer, derivedKey);
    } catch {
      return false;
    }
  }

  static hashSync(password: string): string {
    const salt = crypto.randomBytes(16).toString('hex');
    const derivedKey = crypto.scryptSync(password, salt, 64);
    return `${salt}:${derivedKey.toString('hex')}`;
  }

  static verifySync(password: string, storedHash: string): boolean {
    const [salt, key] = storedHash.split(':');
    if (!salt || !key) return false;

    const keyBuffer = Buffer.from(key, 'hex');
    try {
      const derivedKey = crypto.scryptSync(password, salt, 64);
      return keyBuffer.byteLength === derivedKey.byteLength && crypto.timingSafeEqual(keyBuffer, derivedKey);
    } catch {
      return false;
    }
  }
}

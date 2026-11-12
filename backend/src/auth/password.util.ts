import crypto from 'node:crypto';

/**
 * Secure password hashing using Node.js native crypto.scrypt
 */
export class PasswordUtil {
  static hash(password: string): string {
    const salt = crypto.randomBytes(16).toString('hex');
    const derivedKey = crypto.scryptSync(password, salt, 64);
    return `${salt}:${derivedKey.toString('hex')}`;
  }

  static verify(password: string, storedHash: string): boolean {
    const [salt, key] = storedHash.split(':');
    if (!salt || !key) return false;

    const keyBuffer = Buffer.from(key, 'hex');
    const derivedKey = crypto.scryptSync(password, salt, 64);
    return keyBuffer.byteLength === derivedKey.byteLength && crypto.timingSafeEqual(keyBuffer, derivedKey);
  }
}

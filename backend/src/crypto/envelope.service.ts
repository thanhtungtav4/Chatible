import crypto from 'node:crypto';
import { EncryptedPayload, IKmsProvider } from '@chatible/shared';

/**
 * Envelope Crypto Service
 * AES-256-GCM message encryption with wrapped DEKs.
 */
export class EnvelopeCryptoService {
  constructor(private readonly kms: IKmsProvider) {}

  /**
   * Encrypt a message using a fresh random DEK, then wrap the DEK via KMS
   */
  async encrypt(plaintext: string | Uint8Array): Promise<EncryptedPayload> {
    const rawPlaintext = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;

    // 1. Sinh DEK ngẫu nhiên 32 bytes (256-bit)
    const dek = crypto.randomBytes(32);

    try {
      // 2. Bọc DEK bằng Master KEK qua KMS
      const wrappedDek = await this.kms.wrapKey(dek);

      // 3. Mã hóa nội dung tin nhắn bằng DEK qua AES-256-GCM
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
      const ciphertext = Buffer.concat([cipher.update(rawPlaintext), cipher.final()]);
      const authTag = cipher.getAuthTag();

      return {
        encryptedDek: Buffer.from(wrappedDek).toString('base64'),
        iv: iv.toString('base64'),
        authTag: authTag.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      };
    } finally {
      // 4. Tuyệt đối xóa DEK rõ khỏi RAM ngay lập tức
      dek.fill(0);
    }
  }

  /**
   * Decrypt an encrypted message payload by unwrapping its DEK via KMS
   */
  async decrypt(payload: EncryptedPayload): Promise<string> {
    const wrappedDek = Buffer.from(payload.encryptedDek, 'base64');
    const iv = Buffer.from(payload.iv, 'base64');
    const authTag = Buffer.from(payload.authTag, 'base64');
    const ciphertext = Buffer.from(payload.ciphertext, 'base64');

    // 1. Mở bọc DEK qua KMS
    const dek = await this.kms.unwrapKey(wrappedDek);

    try {
      // 2. Giải mã nội dung
      const decipher = crypto.createDecipheriv('aes-256-gcm', dek, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

      return decrypted.toString('utf8');
    } finally {
      // 3. Xóa DEK rõ khỏi RAM
      Buffer.from(dek).fill(0);
    }
  }
}

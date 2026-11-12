import crypto from 'node:crypto';
import { IKmsProvider } from '@chatible/shared';

/**
 * Local KMS Provider for $0 Envelope Encryption
 * Wraps and unwraps Data Encryption Keys (DEKs) using Master KEK.
 * Master KEK is isolated outside Database.
 */
export class LocalKmsService implements IKmsProvider {
  private readonly kek: Buffer;

  constructor(masterKekHexOrBuffer: string | Buffer) {
    if (typeof masterKekHexOrBuffer === 'string') {
      this.kek = Buffer.from(masterKekHexOrBuffer, 'hex');
    } else {
      this.kek = masterKekHexOrBuffer;
    }

    if (this.kek.length !== 32) {
      throw new Error(`Master KEK must be exactly 32 bytes (256 bits). Current length: ${this.kek.length}`);
    }
  }

  /**
   * Bọc DEK bằng Master KEK qua AES-256-GCM (Authenticated Envelope Wrap)
   * Output format: [12 bytes IV][16 bytes AuthTag][32 bytes Encrypted DEK] (Total 60 bytes)
   */
  async wrapKey(plaintextDek: Uint8Array): Promise<Uint8Array> {
    if (plaintextDek.length !== 32) {
      throw new Error(`Plaintext DEK must be 32 bytes. Got: ${plaintextDek.length}`);
    }

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.kek, iv);
    const encrypted = Buffer.concat([cipher.update(plaintextDek), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return Buffer.concat([iv, authTag, encrypted]);
  }

  /**
   * Mở bọc DEK bằng Master KEK
   */
  async unwrapKey(encryptedDek: Uint8Array): Promise<Uint8Array> {
    if (encryptedDek.length < 60) {
      throw new Error(`Invalid wrapped DEK length: ${encryptedDek.length}`);
    }

    const buf = Buffer.from(encryptedDek);
    const iv = buf.subarray(0, 12);
    const authTag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);

    const decipher = crypto.createDecipheriv('aes-256-gcm', this.kek, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (decrypted.length !== 32) {
      throw new Error(`Unwrapped DEK has invalid length: ${decrypted.length}`);
    }

    return decrypted;
  }
}

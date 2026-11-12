import { describe, it, expect } from 'bun:test';
import { LocalKmsService } from '../kms/local-kms.service.js';
import { EnvelopeCryptoService } from './envelope.service.js';

describe('Local KMS & Envelope Encryption Tests', () => {
  const masterKekHex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const kms = new LocalKmsService(masterKekHex);
  const cryptoService = new EnvelopeCryptoService(kms);

  it('T010 & T011: Encrypts message with wrapped DEK and decrypts cleanly', async () => {
    const secretMessage = 'Xin chào người lạ! Cuộc trò chuyện này được mã hóa Envelope an toàn.';
    
    // Encrypt
    const encrypted = await cryptoService.encrypt(secretMessage);

    // Verify properties
    expect(encrypted.encryptedDek).toBeDefined();
    expect(encrypted.iv).toBeDefined();
    expect(encrypted.authTag).toBeDefined();
    expect(encrypted.ciphertext).toBeDefined();

    // Verify plaintext is NOT in ciphertext or payload
    expect(encrypted.ciphertext).not.toContain(secretMessage);
    expect(Buffer.from(encrypted.ciphertext, 'base64').toString('utf8')).not.toContain('Xin chào');

    // Decrypt
    const decrypted = await cryptoService.decrypt(encrypted);
    expect(decrypted).toBe(secretMessage);
  });

  it('Rejects decryption if ciphertext is tampered with', async () => {
    const encrypted = await cryptoService.encrypt('Test message');
    
    // Tamper ciphertext
    const tampered = {
      ...encrypted,
      ciphertext: Buffer.from('corrupted_content').toString('base64'),
    };

    expect(cryptoService.decrypt(tampered)).rejects.toThrow();
  });

  it('Rejects decryption with a different Master KEK (DB dump proof)', async () => {
    const encrypted = await cryptoService.encrypt('Top secret data');

    // Hacker tries to decrypt using a different fake KEK
    const fakeKms = new LocalKmsService('fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210');
    const attackerCrypto = new EnvelopeCryptoService(fakeKms);

    // Unwrapping DEK fails
    expect(attackerCrypto.decrypt(encrypted)).rejects.toThrow();
  });
});

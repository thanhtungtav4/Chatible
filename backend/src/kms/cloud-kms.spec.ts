import { describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { AwsKmsService, type KeyAccessAuditEvent } from './cloud-kms.service.js';
import { buildValidatedConfig } from '../config/env.js';

describe('Cloud KMS and production configuration hardening', () => {
  it('wraps and unwraps 32-byte DEKs via mocked AWS KMS client and emits key-access audit hooks', async () => {
    const auditEvents: KeyAccessAuditEvent[] = [];
    const masterSecret = Buffer.alloc(32, 0xaa);

    const mockClient = {
      async send(command: unknown) {
        const cmd = command as { constructor: { name: string }; input: Record<string, unknown> };
        expect(cmd.input.KeyId).toBe('arn:aws:kms:ap-southeast-1:123456789012:key/test-key');
        expect(cmd.input.EncryptionContext).toEqual({ app: 'chatible', purpose: 'envelope_dek' });

        if (cmd.constructor.name === 'EncryptCommand') {
          const plaintext = Buffer.from(cmd.input.Plaintext as Uint8Array);
          const xorBlob = Buffer.from(plaintext.map((b, i) => b ^ masterSecret[i % masterSecret.length]!));
          return { CiphertextBlob: xorBlob };
        }
        if (cmd.constructor.name === 'DecryptCommand') {
          const cipherBlob = Buffer.from(cmd.input.CiphertextBlob as Uint8Array);
          const restored = Buffer.from(cipherBlob.map((b, i) => b ^ masterSecret[i % masterSecret.length]!));
          return { Plaintext: restored };
        }
        throw new Error(`Unexpected command ${cmd.constructor.name}`);
      },
    };

    const kms = new AwsKmsService({
      keyId: 'arn:aws:kms:ap-southeast-1:123456789012:key/test-key',
      region: 'ap-southeast-1',
      client: mockClient as never,
      auditHook: (evt) => auditEvents.push(evt),
    });

    const dek = randomBytes(32);
    const wrapped = await kms.wrapKey(dek);
    expect(Buffer.from(wrapped).equals(dek)).toBe(false);

    const unwrapped = await kms.unwrapKey(wrapped);
    expect(Buffer.from(unwrapped).equals(dek)).toBe(true);

    expect(auditEvents.map((e) => `${e.operation}:${e.outcome}`)).toEqual([
      'WRAP_KEY:SUCCESS',
      'UNWRAP_KEY:SUCCESS',
    ]);
    await expect(kms.wrapKey(Buffer.alloc(16))).rejects.toThrow('32 bytes');
  });

  it('enforces Cloud KMS and HTTPS S3 endpoint in production without requiring APP_MASTER_KEK', () => {
    const validProdEnv: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://chatible:secret@db.internal:5432/chatible',
      JWT_SECRET: 'a'.repeat(48),
      ADMIN_JWT_SECRET: 'b'.repeat(48),
      ADMIN_SECRET_TOKEN: 'c'.repeat(48),
      ADMIN_TOTP_SECRET: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
      KMS_PROVIDER: 'aws-kms',
      AWS_KMS_KEY_ID: 'arn:aws:kms:ap-southeast-1:111122223333:key/abcd-1234',
      AWS_KMS_REGION: 'ap-southeast-1',
      S3_ENDPOINT: 'https://s3.ap-southeast-1.amazonaws.com',
      S3_BUCKET: 'chatible-media-prod',
      S3_ACCESS_KEY_ID: 'AKIAEXAMPLEREALACCESSKEY',
      S3_SECRET_ACCESS_KEY: 'super-real-secret-access-key-value-123',
    };

    const validated = buildValidatedConfig(validProdEnv);
    expect(validated.kmsProvider).toBe('aws-kms');
    expect(validated.objectStorage.endpoint).toBe('https://s3.ap-southeast-1.amazonaws.com');
    expect(validated.awsKms.keyId).toBe(validProdEnv.AWS_KMS_KEY_ID);

    // Reject HTTP S3 endpoint in production
    expect(() =>
      buildValidatedConfig({ ...validProdEnv, S3_ENDPOINT: 'http://minio.internal:9000' })
    ).toThrow('HTTPS');

    // Reject local KMS in production unless explicit isolated staging override
    expect(() =>
      buildValidatedConfig({ ...validProdEnv, KMS_PROVIDER: 'local', APP_MASTER_KEK: 'd'.repeat(64) })
    ).toThrow('aws-kms');

    // Require AWS_KMS_KEY_ID when KMS_PROVIDER=aws-kms in production
    expect(() =>
      buildValidatedConfig({ ...validProdEnv, AWS_KMS_KEY_ID: '' })
    ).toThrow('AWS_KMS_KEY_ID');

    // Require ADMIN_TOTP_SECRET in production
    expect(() =>
      buildValidatedConfig({ ...validProdEnv, ADMIN_TOTP_SECRET: '' })
    ).toThrow('ADMIN_TOTP_SECRET');
    expect(() =>
      buildValidatedConfig({ ...validProdEnv, ADMIN_TOTP_SECRET: 'short' })
    ).toThrow('ADMIN_TOTP_SECRET');
  });
});

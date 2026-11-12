import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';
import type { IKmsProvider } from '@chatible/shared';
import { config } from '../config/env.js';
import { LocalKmsService } from './local-kms.service.js';

export interface KeyAccessAuditEvent {
  operation: 'WRAP_KEY' | 'UNWRAP_KEY';
  provider: 'aws-kms' | 'local';
  keyRef: string;
  outcome: 'SUCCESS' | 'ERROR';
  timestamp: string;
}

export type KeyAccessAuditHook = (event: KeyAccessAuditEvent) => void;

export interface CloudKmsOptions {
  keyId: string;
  region: string;
  endpoint?: string;
  client?: Pick<KMSClient, 'send'>;
  auditHook?: KeyAccessAuditHook;
}

const ENCRYPTION_CONTEXT = { app: 'chatible', purpose: 'envelope_dek' };

/**
 * Customer-managed Cloud KMS provider backed by AWS KMS (D30).
 * Keeps master KEK strictly inside customer Cloud KMS/HSM; raw KEK never touches app RAM.
 */
export class AwsKmsService implements IKmsProvider {
  private readonly client: Pick<KMSClient, 'send'>;
  private readonly keyId: string;
  private readonly auditHook?: KeyAccessAuditHook;

  constructor(options: CloudKmsOptions) {
    if (!options.keyId) {
      throw new Error('AWS_KMS_KEY_ID is required for AwsKmsService.');
    }
    this.keyId = options.keyId;
    this.auditHook = options.auditHook;
    this.client =
      options.client ??
      new KMSClient({
        region: options.region,
        ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      });
  }

  private emitAudit(operation: 'WRAP_KEY' | 'UNWRAP_KEY', outcome: 'SUCCESS' | 'ERROR'): void {
    const evt: KeyAccessAuditEvent = {
      operation,
      provider: 'aws-kms',
      keyRef: this.keyId.slice(0, 48),
      outcome,
      timestamp: new Date().toISOString(),
    };
    this.auditHook?.(evt);
  }

  async wrapKey(plaintextDek: Uint8Array): Promise<Uint8Array> {
    if (plaintextDek.length !== 32) {
      throw new Error(`Plaintext DEK must be 32 bytes. Got: ${plaintextDek.length}`);
    }
    try {
      const response = (await this.client.send(
        new EncryptCommand({
          KeyId: this.keyId,
          Plaintext: Buffer.from(plaintextDek),
          EncryptionContext: ENCRYPTION_CONTEXT,
        })
      )) as { CiphertextBlob?: Uint8Array };
      if (!response.CiphertextBlob || response.CiphertextBlob.length === 0) {
        throw new Error('AWS KMS Encrypt returned an empty CiphertextBlob.');
      }
      this.emitAudit('WRAP_KEY', 'SUCCESS');
      return Uint8Array.from(response.CiphertextBlob);
    } catch (err) {
      this.emitAudit('WRAP_KEY', 'ERROR');
      throw err;
    }
  }

  async unwrapKey(encryptedDek: Uint8Array): Promise<Uint8Array> {
    if (!encryptedDek || encryptedDek.length === 0) {
      throw new Error('Invalid wrapped DEK buffer.');
    }
    try {
      const response = (await this.client.send(
        new DecryptCommand({
          KeyId: this.keyId,
          CiphertextBlob: Buffer.from(encryptedDek),
          EncryptionContext: ENCRYPTION_CONTEXT,
        })
      )) as { Plaintext?: Uint8Array };
      if (!response.Plaintext || response.Plaintext.length !== 32) {
        throw new Error('AWS KMS Decrypt returned an invalid DEK length.');
      }
      this.emitAudit('UNWRAP_KEY', 'SUCCESS');
      return Uint8Array.from(response.Plaintext);
    } catch (err) {
      this.emitAudit('UNWRAP_KEY', 'ERROR');
      throw err;
    }
  }
}

export function createConfiguredKms(auditHook?: KeyAccessAuditHook): {
  kms: IKmsProvider;
  providerLabel: string;
} {
  if (config.kmsProvider === 'aws-kms') {
    return {
      kms: new AwsKmsService({
        keyId: config.awsKms.keyId,
        region: config.awsKms.region,
        endpoint: config.awsKms.endpoint || undefined,
        auditHook,
      }),
      providerLabel: 'aws-kms-active',
    };
  }

  return {
    kms: new LocalKmsService(config.masterKek),
    providerLabel: 'local-envelope-active',
  };
}

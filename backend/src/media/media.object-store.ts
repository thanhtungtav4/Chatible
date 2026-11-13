import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config/env.js';
import { MediaError, type MediaObjectStore } from './media.types.js';
import { db } from '../database/index.js';
import { systemSettings } from '../database/schema/settings.js';
import { inArray } from 'drizzle-orm';
import { decryptSettingSecret } from '../mail/mail.service.js';
import { EnvelopeCryptoService } from '../crypto/envelope.service.js';

export interface S3ConfigOptions {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  forcePathStyle?: boolean;
}

/**
 * Stores media locally on the VPS filesystem by default.
 * No external S3 bucket required.
 */
export class LocalObjectStore implements MediaObjectStore {
  private readonly baseDir: string;
  private readonly baseUrl: string;

  constructor(options?: { baseDir?: string; baseUrl?: string }) {
    this.baseDir = options?.baseDir || path.resolve(process.cwd(), 'data/media_uploads');
    this.baseUrl = options?.baseUrl || '/api/v1/media/upload-local';
    try {
      fs.mkdirSync(this.baseDir, { recursive: true });
    } catch {}
  }

  private resolvePath(key: string): string {
    const safeKey = key.replace(/(\.\.[\/\\])+/g, '').replace(/^[\\\/]+/, '');
    const fullPath = path.resolve(this.baseDir, safeKey);
    if (!fullPath.startsWith(this.baseDir)) {
      throw new MediaError(400, 'Đường dẫn tệp không hợp lệ.');
    }
    return fullPath;
  }

  async presignPut(input: { key: string; contentType: string; contentLength: number; mediaId: string }): Promise<string> {
    const encodedKey = encodeURIComponent(input.key);
    return `${this.baseUrl}/${encodedKey}`;
  }

  async putStream(input: {
    key: string;
    body: NodeJS.ReadableStream | Buffer;
    contentType: string;
    contentLength: number;
  }): Promise<void> {
    const fullPath = this.resolvePath(input.key);
    const dir = path.dirname(fullPath);
    await fs.promises.mkdir(dir, { recursive: true });

    if (Buffer.isBuffer(input.body)) {
      await fs.promises.writeFile(fullPath, input.body);
    } else {
      const writeStream = fs.createWriteStream(fullPath);
      await pipeline(input.body as Readable, writeStream);
    }
  }

  async head(key: string): Promise<{ exists: boolean; contentLength?: number; contentType?: string }> {
    try {
      const fullPath = this.resolvePath(key);
      const stat = await fs.promises.stat(fullPath);
      return { exists: true, contentLength: stat.size };
    } catch {
      return { exists: false };
    }
  }

  async exists(key: string): Promise<boolean> {
    const info = await this.head(key);
    return info.exists;
  }

  async delete(key: string): Promise<void> {
    try {
      const fullPath = this.resolvePath(key);
      await fs.promises.unlink(fullPath);
    } catch {
      // Ignore if file doesn't exist
    }
  }

  async get(key: string): Promise<{ body: unknown; contentType?: string; contentLength?: number }> {
    const fullPath = this.resolvePath(key);
    try {
      const stat = await fs.promises.stat(fullPath);
      const stream = fs.createReadStream(fullPath);
      return { body: stream, contentLength: stat.size };
    } catch {
      throw new MediaError(404, 'Tệp media không tồn tại trong kho lưu trữ cục bộ.');
    }
  }
}

/**
 * Standard AWS S3 / Cloudflare R2 / MinIO Object Storage implementation
 */
export class S3ObjectStore implements MediaObjectStore {
  private client: S3Client | null = null;
  private bucket: string = '';

  constructor(customConfig?: S3ConfigOptions) {
    if (customConfig) {
      this.reconfigure(customConfig);
    } else {
      const storage = config.objectStorage;
      if (storage.endpoint && storage.accessKeyId && storage.secretAccessKey && storage.bucket) {
        this.reconfigure({
          endpoint: storage.endpoint,
          bucket: storage.bucket,
          accessKeyId: storage.accessKeyId,
          secretAccessKey: storage.secretAccessKey,
          region: storage.region,
          forcePathStyle: storage.forcePathStyle,
        });
      }
    }
  }

  reconfigure(options: S3ConfigOptions): void {
    this.bucket = options.bucket;
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region || 'auto',
      forcePathStyle: Boolean(options.forcePathStyle),
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  isConfigured(): boolean {
    return Boolean(this.client && this.bucket);
  }

  private getClient(): S3Client {
    if (!this.client || !this.bucket) {
      throw new MediaError(503, 'Media object storage is not configured.');
    }
    return this.client;
  }

  async presignPut(input: { key: string; contentType: string; contentLength: number; mediaId: string }): Promise<string> {
    return getSignedUrl(
      this.getClient(),
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        ContentType: 'application/octet-stream',
        ContentLength: input.contentLength,
        Metadata: { 'media-id': input.mediaId },
      }),
      { expiresIn: 900 }
    );
  }

  async putStream(input: {
    key: string;
    body: NodeJS.ReadableStream | Buffer;
    contentType: string;
    contentLength: number;
  }): Promise<void> {
    const client = this.getClient();
    await client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body as never,
        ContentType: input.contentType,
        ContentLength: input.contentLength,
      })
    );
  }

  async head(key: string): Promise<{ exists: boolean; contentLength?: number; contentType?: string }> {
    const client = this.getClient();
    try {
      const res = await client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { exists: true, contentLength: res.ContentLength, contentType: res.ContentType };
    } catch (error) {
      const storageError = error as { $metadata?: { httpStatusCode?: number }; name?: string };
      const status = storageError.$metadata?.httpStatusCode;
      if (status === 404 || storageError.name === 'NotFound') return { exists: false };
      throw new MediaError(503, 'Media object storage is unavailable.');
    }
  }

  async exists(key: string): Promise<boolean> {
    const info = await this.head(key);
    return info.exists;
  }

  async delete(key: string): Promise<void> {
    const client = this.getClient();
    try {
      await client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch {
      throw new MediaError(503, 'Media object storage is unavailable.');
    }
  }

  async get(key: string): Promise<{ body: unknown; contentType?: string; contentLength?: number }> {
    const result = await this.getClient().send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return { body: result.Body, contentType: result.ContentType, contentLength: result.ContentLength };
  }
}

/**
 * Hybrid Object Store:
 * Defaults to Local VPS Storage.
 * Switches to S3 / Cloudflare R2 when configured by admin or environment.
 */
export class HybridObjectStore implements MediaObjectStore {
  private readonly localStore: LocalObjectStore;
  private readonly s3Store: S3ObjectStore;
  private activeDriver: 'LOCAL' | 'S3' = 'LOCAL';
  private lastCheckedAt = 0;

  constructor() {
    this.localStore = new LocalObjectStore();
    this.s3Store = new S3ObjectStore();
    if (this.s3Store.isConfigured()) {
      this.activeDriver = 'S3';
    }
  }

  async syncConfigFromDatabase(): Promise<void> {
    const now = Date.now();
    // Cache for 15 seconds to prevent spamming DB on every request
    if (now - this.lastCheckedAt < 15_000) return;
    this.lastCheckedAt = now;

    try {
      const rows = await db
        .select({ key: systemSettings.key, value: systemSettings.value })
        .from(systemSettings)
        .where(
          inArray(systemSettings.key, [
            'storage.driver',
            'storage.s3.endpoint',
            'storage.s3.bucket',
            'storage.s3.access_key_id',
            'storage.s3.secret_access_key',
            'storage.s3.region',
            'storage.s3.force_path_style',
          ])
        );

      const map = new Map<string, string>();
      for (const r of rows) map.set(r.key, r.value);

      const driver = map.get('storage.driver') || (this.s3Store.isConfigured() ? 'S3' : 'LOCAL');
      const endpoint = map.get('storage.s3.endpoint') || config.objectStorage.endpoint;
      const bucket = map.get('storage.s3.bucket') || config.objectStorage.bucket;
      const accessKeyId = map.get('storage.s3.access_key_id') || config.objectStorage.accessKeyId;
      let secretKey = map.get('storage.s3.secret_access_key') || config.objectStorage.secretAccessKey;

      if (secretKey && secretKey.startsWith('enc:')) {
        try {
          const crypto = new EnvelopeCryptoService(config.appMasterKek);
          secretKey = await decryptSettingSecret(secretKey, crypto);
        } catch {}
      }

      const region = map.get('storage.s3.region') || config.objectStorage.region || 'auto';
      const forcePathStyle = map.get('storage.s3.force_path_style') === 'true' || config.objectStorage.forcePathStyle;

      if (driver === 'S3' && endpoint && bucket && accessKeyId && secretKey) {
        this.s3Store.reconfigure({
          endpoint,
          bucket,
          accessKeyId,
          secretAccessKey: secretKey,
          region,
          forcePathStyle,
        });
        this.activeDriver = 'S3';
      } else {
        this.activeDriver = 'LOCAL';
      }
    } catch {
      // Fallback cleanly to local
    }
  }

  getActiveDriver(): 'LOCAL' | 'S3' {
    return this.activeDriver;
  }

  async presignPut(input: { key: string; contentType: string; contentLength: number; mediaId: string }): Promise<string> {
    await this.syncConfigFromDatabase();
    if (this.activeDriver === 'S3' && this.s3Store.isConfigured()) {
      return this.s3Store.presignPut(input);
    }
    return this.localStore.presignPut(input);
  }

  async putStream(input: {
    key: string;
    body: NodeJS.ReadableStream | Buffer;
    contentType: string;
    contentLength: number;
  }): Promise<void> {
    await this.syncConfigFromDatabase();
    if (this.activeDriver === 'S3' && this.s3Store.isConfigured()) {
      return this.s3Store.putStream(input);
    }
    return this.localStore.putStream(input);
  }

  async head(key: string): Promise<{ exists: boolean; contentLength?: number; contentType?: string }> {
    // Check local store first (immediate)
    const localHead = await this.localStore.head(key);
    if (localHead.exists) return localHead;

    // Check S3 store if configured
    if (this.s3Store.isConfigured()) {
      try {
        const s3Head = await this.s3Store.head(key);
        if (s3Head.exists) return s3Head;
      } catch {}
    }
    return { exists: false };
  }

  async exists(key: string): Promise<boolean> {
    const res = await this.head(key);
    return res.exists;
  }

  async get(key: string): Promise<{ body: unknown; contentType?: string; contentLength?: number }> {
    // Check local file first
    const localExists = await this.localStore.exists(key);
    if (localExists) {
      return this.localStore.get(key);
    }

    // Otherwise fetch from S3
    if (this.s3Store.isConfigured()) {
      return this.s3Store.get(key);
    }

    throw new MediaError(404, 'Tệp media không tồn tại trong kho lưu trữ.');
  }

  async delete(key: string): Promise<void> {
    await Promise.all([
      this.localStore.delete(key).catch(() => {}),
      this.s3Store.isConfigured() ? this.s3Store.delete(key).catch(() => {}) : Promise.resolve(),
    ]);
  }
}

let defaultStoreInstance: MediaObjectStore | null = null;

export function createDefaultObjectStore(): MediaObjectStore {
  if (!defaultStoreInstance) {
    defaultStoreInstance = new HybridObjectStore();
  }
  return defaultStoreInstance;
}

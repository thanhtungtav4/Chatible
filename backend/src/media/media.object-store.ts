import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config/env.js';
import { MediaError, type MediaObjectStore } from './media.types.js';

export class S3ObjectStore implements MediaObjectStore {
  private readonly client: S3Client | null;
  private readonly bucket: string;

  constructor() {
    const storage = config.objectStorage;
    this.bucket = storage.bucket;
    this.client =
      storage.endpoint && storage.accessKeyId && storage.secretAccessKey && this.bucket
        ? new S3Client({
            endpoint: storage.endpoint,
            region: storage.region,
            forcePathStyle: storage.forcePathStyle,
            credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey },
          })
        : null;
  }

  private getClient(): S3Client {
    if (!this.client) throw new MediaError(503, 'Media object storage is not configured.');
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

export function createDefaultObjectStore(): MediaObjectStore {
  return new S3ObjectStore();
}

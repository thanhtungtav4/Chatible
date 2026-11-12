import crypto from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Redis from 'ioredis';
import type { IKmsProvider } from '@chatible/shared';
import { config } from '../config/env.js';
import { createConfiguredKms } from '../kms/cloud-kms.service.js';
import {
  burnVideoWatermarkFile,
  probeFfmpegAvailable,
  streamDecryptToFile,
  streamEncryptFileToTemp,
} from './media-processing.util.js';
import {
  createDefaultMediaRepository,
  createDefaultObjectStore,
  type MediaObjectStore,
  type MediaRepository,
} from './media.service.js';
import { RedisVideoWatermarkQueue, type VideoWatermarkJob } from './media-queue.service.js';

export interface VideoWatermarkWorkerOptions {
  repository?: MediaRepository;
  storage?: MediaObjectStore;
  kms?: IKmsProvider;
  queue: RedisVideoWatermarkQueue;
  timeoutMs?: number;
  threads?: number;
}

export class VideoWatermarkWorker {
  private readonly repository: MediaRepository;
  private readonly storage: MediaObjectStore;
  private readonly kms: IKmsProvider;
  private readonly queue: RedisVideoWatermarkQueue;
  private readonly timeoutMs: number;
  private readonly threads: number;

  constructor(options: VideoWatermarkWorkerOptions) {
    this.repository = options.repository ?? createDefaultMediaRepository();
    this.storage = options.storage ?? createDefaultObjectStore();
    this.kms = options.kms ?? createConfiguredKms().kms;
    this.queue = options.queue;
    this.timeoutMs = options.timeoutMs ?? Number.parseInt(process.env.MEDIA_WORKER_TIMEOUT_MS || '60000', 10);
    this.threads = Math.max(1, options.threads ?? Number.parseInt(process.env.MEDIA_WORKER_THREADS || '1', 10));
  }

  async processJob(job: VideoWatermarkJob): Promise<'READY' | 'FAILED' | 'SKIPPED'> {
    const { mediaId, recipientId } = job;
    const lockId = await this.queue.acquireSlot();
    if (!lockId) {
      await this.queue.clearDedup(job);
      await this.queue.requeue(job);
      await new Promise((r) => setTimeout(r, 400));
      return 'SKIPPED';
    }

    const asset = await this.repository.getAsset(mediaId);
    const variant = await this.repository.getWatermarkedVariant?.(mediaId, recipientId);
    if (!asset || asset.revokedAt || asset.expiresAt.getTime() <= Date.now() || asset.status !== 'READY' || !variant) {
      await this.queue.releaseSlot(lockId);
      await this.queue.clearDedup(job);
      return 'SKIPPED';
    }
    if (variant.status === 'READY' && (await this.storage.exists(variant.objectKey))) {
      await this.queue.releaseSlot(lockId);
      await this.queue.clearDedup(job);
      return 'READY';
    }

    const mime = asset.verifiedMime || asset.contentType;
    const ext = mime.includes('webm') ? 'webm' : 'mp4';
    const recipientHash = crypto.createHash('sha256').update(recipientId).digest('hex').slice(0, 16);
    const targetObjectKey = variant.objectKey || `media-variants/${asset.sessionId}/${mediaId}/${recipientHash}.enc`;

    await this.repository.upsertWatermarkedVariant?.({
      mediaId,
      recipientId,
      objectKey: targetObjectKey,
      encryptedDek: variant.encryptedDek,
      iv: variant.iv,
      authTag: variant.authTag,
      contentType: mime,
      fileSize: variant.fileSize,
      traceCode: variant.traceCode,
      watermarkText: variant.watermarkText,
      status: 'PROCESSING',
      error: null,
      expiresAt: asset.expiresAt,
    });

    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatible-vw-'));
    const inputPath = path.join(workDir, `in.${ext}`);
    const watermarkedPath = path.join(workDir, `out.${ext}`);
    const encryptedOutPath = path.join(workDir, 'out.enc');
    let assetDek: Uint8Array | null = null;
    const variantDek = crypto.randomBytes(32);

    try {
      const obj = await this.storage.get(asset.objectKey);
      assetDek = await this.kms.unwrapKey(Buffer.from(asset.encryptedDek, 'base64'));
      await streamDecryptToFile({
        body: obj.body,
        rawKey: assetDek,
        ivBase64: asset.iv,
        authTagBase64: asset.authTag,
        outPath: inputPath,
        maxBytes: 100_000_000,
      });

      const ok = await burnVideoWatermarkFile({
        inputPath,
        outputPath: watermarkedPath,
        mime,
        watermarkText: variant.watermarkText,
        timeoutMs: this.timeoutMs,
        threads: this.threads,
      });
      if (!ok) {
        throw new Error('FFmpeg không thể nhúng watermark cho video này (timeout hoặc định dạng lỗi).');
      }

      const encryptedMeta = await streamEncryptFileToTemp({
        inputPath: watermarkedPath,
        encryptedOutPath,
        rawKey: variantDek,
      });
      const wrappedVariantDek = Buffer.from(await this.kms.wrapKey(variantDek)).toString('base64');

      if (!this.storage.putStream) {
        throw new Error('Object store không hỗ trợ ghi variant stream.');
      }
      const rs = createReadStream(encryptedOutPath);
      await this.storage.putStream({
        key: targetObjectKey,
        body: rs,
        contentType: 'application/octet-stream',
        contentLength: encryptedMeta.encryptedSize,
      });

      await this.repository.upsertWatermarkedVariant?.({
        mediaId,
        recipientId,
        objectKey: targetObjectKey,
        encryptedDek: wrappedVariantDek,
        iv: encryptedMeta.iv,
        authTag: encryptedMeta.authTag,
        contentType: ext === 'webm' ? 'video/webm' : 'video/mp4',
        fileSize: encryptedMeta.encryptedSize,
        traceCode: variant.traceCode,
        watermarkText: variant.watermarkText,
        status: 'READY',
        error: null,
        expiresAt: asset.expiresAt,
      });

      return 'READY';
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Lỗi worker xử lý video.';
      await this.repository.upsertWatermarkedVariant?.({
        mediaId,
        recipientId,
        objectKey: targetObjectKey,
        encryptedDek: '',
        iv: '',
        authTag: '',
        contentType: mime,
        fileSize: asset.fileSize,
        traceCode: variant.traceCode,
        watermarkText: variant.watermarkText,
        status: 'FAILED',
        error: msg.slice(0, 400),
        expiresAt: asset.expiresAt,
      });
      return 'FAILED';
    } finally {
      if (assetDek) Buffer.from(assetDek).fill(0);
      variantDek.fill(0);
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      await this.queue.releaseSlot(lockId);
      await this.queue.clearDedup(job);
    }
  }
}

export async function startWorkerLoop(): Promise<void> {
  const ffmpegProbe = await probeFfmpegAvailable();
  if (!ffmpegProbe.ok) {
    console.error(`[MediaWorker] Fatal: FFmpeg binary unavailable or broken: ${ffmpegProbe.error || 'unknown error'}`);
    process.exit(1);
    return;
  }

  const workerId = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;
  const controlRedis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  const blockingRedis = controlRedis.duplicate();
  const queue = new RedisVideoWatermarkQueue(controlRedis);
  const worker = new VideoWatermarkWorker({ queue });

  let running = true;
  let lastFfmpegOk = true;
  let ticksSinceProbe = 0;

  await queue.publishHeartbeat(workerId, { pid: process.pid, ffmpegOk: lastFfmpegOk, concurrency: queue.maxConcurrency });

  const heartbeatTimer = setInterval(() => {
    if (!running) return;
    void (async () => {
      try {
        ticksSinceProbe += 1;
        if (ticksSinceProbe >= 12) {
          ticksSinceProbe = 0;
          lastFfmpegOk = (await probeFfmpegAvailable()).ok;
        }
        await queue.publishHeartbeat(workerId, {
          pid: process.pid,
          ffmpegOk: lastFfmpegOk,
          concurrency: queue.maxConcurrency,
        });
      } catch (err) {
        console.error('[MediaWorker] Heartbeat publish failed:', err);
      }
    })();
  }, 5_000);
  heartbeatTimer.unref();

  const shutdown = async () => {
    running = false;
    clearInterval(heartbeatTimer);
    await queue.clearHeartbeat(workerId);
    await Promise.allSettled([blockingRedis.quit(), controlRedis.quit()]);
  };
  process.on('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });

  console.info(
    `[MediaWorker] Started isolated video watermark worker (${workerId}, concurrency=${queue.maxConcurrency}, ffmpeg=${ffmpegProbe.version ?? 'ok'})`
  );
  while (running) {
    try {
      const job = await queue.popBlocking(blockingRedis, 2);
      if (job) {
        await worker.processJob(job);
      }
    } catch (err) {
      if (!running) break;
      console.error('[MediaWorker] Loop error:', err);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

const isEntrypoint = process.argv[1]?.includes('media-worker.process');
if (isEntrypoint) {
  void startWorkerLoop();
}

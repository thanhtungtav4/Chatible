import { describe, expect, it } from 'bun:test';
import { execFile } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Redis from 'ioredis';
import { and, eq, inArray } from 'drizzle-orm';
import { JwtUtil } from '../auth/jwt.util.js';
import {
  CSRF_COOKIE_NAME,
  registerCsrfOriginProtection,
  SESSION_COOKIE_NAME,
} from '../auth/session-auth.util.js';
import { config } from '../config/env.js';
import { db } from '../database/index.js';
import { mediaAssets, mediaWatermarkedVariants } from '../database/schema/media.js';
import { chatSessions } from '../database/schema/sessions.js';
import { profiles, users } from '../database/schema/users.js';
import { LocalKmsService } from '../kms/local-kms.service.js';
import { MediaController } from './media.controller.js';
import { RedisVideoWatermarkQueue } from './media-queue.service.js';
import { probeFfmpegAvailable } from './media-processing.util.js';
import { MediaService, type MediaObjectStore } from './media.service.js';
import { VideoWatermarkWorker } from './media-worker.process.js';

const execFileAsync = promisify(execFile);

function resolveFfmpegBin(): string {
  if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH;
  }
  if (existsSync('/opt/homebrew/bin/ffmpeg')) {
    return '/opt/homebrew/bin/ffmpeg';
  }
  return 'ffmpeg';
}

async function consumeToBuffer(body: Buffer | NodeJS.ReadableStream): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function generateSyntheticMp4(workDir: string): Promise<Buffer> {
  const outPath = path.join(workDir, 'sample.mp4');
  await execFileAsync(
    resolveFfmpegBin(),
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=64x64:d=0.4',
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libx264',
      '-movflags',
      '+faststart',
      outPath,
    ],
    { timeout: 15_000 }
  );
  return fs.readFile(outPath);
}

describe('Video watermark queue, worker offload, concurrency cap, and cached streaming', () => {
  it('enqueues video jobs on 202 cache miss, enforces semaphore=1, processes via worker, and serves cached embedded watermark stream', async () => {
    if (existsSync('/opt/homebrew/bin/ffmpeg') && !process.env.FFMPEG_PATH) {
      process.env.FFMPEG_PATH = '/opt/homebrew/bin/ffmpeg';
    }

    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatible-vw-spec-'));
    const redis = new Redis(config.redisUrl);
    const blockingRedis = new Redis(config.redisUrl);
    const kms = new LocalKmsService('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
    const queue = new RedisVideoWatermarkQueue(redis, { maxConcurrency: 1, lockTtlMs: 30_000 });

    const objects = new Map<string, { body: Buffer; contentType: string }>();
    let putStreamCalls = 0;
    const storage: MediaObjectStore = {
      async presignPut(input) {
        return `https://storage.test/${input.key}`;
      },
      async exists(key) {
        return objects.has(key);
      },
      async head(key) {
        const obj = objects.get(key);
        return obj ? { exists: true, contentLength: obj.body.length, contentType: obj.contentType } : { exists: false };
      },
      async get(key) {
        const obj = objects.get(key);
        if (!obj) throw new Error('missing');
        return { body: obj.body, contentType: obj.contentType, contentLength: obj.body.length };
      },
      async putStream(input) {
        putStreamCalls += 1;
        const buf = await consumeToBuffer(input.body);
        objects.set(input.key, { body: buf, contentType: input.contentType });
      },
      async delete(key) {
        objects.delete(key);
      },
    };

    const mediaService = new MediaService({ storage, kms, videoQueue: queue });
    const worker = new VideoWatermarkWorker({ storage, kms, queue, timeoutMs: 25_000, threads: 1 });
    const app = fastify({ logger: false });
    await app.register(fastifyCookie);
    registerCsrfOriginProtection(app);
    new MediaController(mediaService).registerRoutes(app);
    await app.ready();

    const [userA, userB] = [randomUUID(), randomUUID()];
    const sessionId = randomUUID();
    let mediaId = '';
    let spoofedMediaId = '';

    try {
      await redis.del('queue:media:video:jobs', 'sem:media:video:active', 'health:media:workers');
      const existingHeartbeatKeys = await redis.keys('health:media:worker:*');
      if (existingHeartbeatKeys.length > 0) await redis.del(...existingHeartbeatKeys);

      await db.insert(users).values([
        { id: userA, email: `vw-a-${userA}@chatible.test` },
        { id: userB, email: `vw-b-${userB}@chatible.test` },
      ]);
      await db.insert(profiles).values([
        { userId: userA, nickname: 'VideoSender', gender: 'MALE', birthDate: '1993-01-01', calculatedAge: 33 },
        { userId: userB, nickname: 'VideoViewer', gender: 'FEMALE', birthDate: '1995-01-01', calculatedAge: 31 },
      ]);
      await db.insert(chatSessions).values({
        id: sessionId,
        sessionType: 'RANDOM',
        userAId: userA,
        userBId: userB,
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 86_400_000),
      });

      await mediaService.setConsent(userB, sessionId, true);

      const csrf = 'video-worker-csrf-token';
      const tokenA = JwtUtil.sign({ sub: userA, email: `vw-a-${userA}@chatible.test` }, config.jwtSecret);
      const tokenB = JwtUtil.sign({ sub: userB, email: `vw-b-${userB}@chatible.test` }, config.jwtSecret);
      const cookieA = `${SESSION_COOKIE_NAME}=${encodeURIComponent(tokenA)}; ${CSRF_COOKIE_NAME}=${csrf}`;
      const cookieB = `${SESSION_COOKIE_NAME}=${encodeURIComponent(tokenB)}; ${CSRF_COOKIE_NAME}=${csrf}`;

      // 1. Streaming completeUpload rejects spoofed video bytes (415) and cleans up object
      const spoofedDek = randomBytes(32);
      const spoofedIv = randomBytes(12);
      const spoofedCipher = createCipheriv('aes-256-gcm', spoofedDek, spoofedIv);
      const spoofedPayload = Buffer.concat([spoofedCipher.update(Buffer.from('not-an-mp4-binary')), spoofedCipher.final()]);
      const spoofedTag = spoofedCipher.getAuthTag();

      const spoofPresign = await app.inject({
        method: 'POST',
        url: '/api/v1/media/presign-upload',
        headers: { cookie: cookieA, 'x-csrf-token': csrf },
        payload: {
          sessionId,
          recipientId: userB,
          contentType: 'video/mp4',
          mediaType: 'VIDEO',
          fileSize: spoofedPayload.length,
          dek: spoofedDek.toString('base64'),
          iv: spoofedIv.toString('base64'),
          authTag: spoofedTag.toString('base64'),
        },
      });
      expect(spoofPresign.statusCode).toBe(200);
      spoofedMediaId = spoofPresign.json().mediaId;
      const [spoofAsset] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, spoofedMediaId));
      objects.set(spoofAsset!.objectKey, { body: spoofedPayload, contentType: 'application/octet-stream' });

      const spoofComplete = await app.inject({
        method: 'POST',
        url: `/api/v1/media/${spoofedMediaId}/complete`,
        headers: { cookie: cookieA, 'x-csrf-token': csrf },
      });
      expect(spoofComplete.statusCode).toBe(415);
      expect(objects.has(spoofAsset!.objectKey)).toBe(false);

      // 2. Upload real FFmpeg MP4 encrypted with AES-256-GCM
      const rawMp4 = await generateSyntheticMp4(workDir);
      expect(rawMp4.subarray(4, 8).toString('ascii')).toBe('ftyp');

      const rawDek = randomBytes(32);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', rawDek, iv);
      const encryptedMp4 = Buffer.concat([cipher.update(rawMp4), cipher.final()]);
      const tag = cipher.getAuthTag();

      const presignRes = await app.inject({
        method: 'POST',
        url: '/api/v1/media/presign-upload',
        headers: { cookie: cookieA, 'x-csrf-token': csrf },
        payload: {
          sessionId,
          recipientId: userB,
          contentType: 'video/mp4',
          mediaType: 'VIDEO',
          fileSize: encryptedMp4.length,
          dek: rawDek.toString('base64'),
          iv: iv.toString('base64'),
          authTag: tag.toString('base64'),
        },
      });
      expect(presignRes.statusCode).toBe(200);
      mediaId = presignRes.json().mediaId;

      const [assetRow] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, mediaId));
      objects.set(assetRow!.objectKey, { body: encryptedMp4, contentType: 'application/octet-stream' });

      const completeRes = await app.inject({
        method: 'POST',
        url: `/api/v1/media/${mediaId}/complete`,
        headers: { cookie: cookieA, 'x-csrf-token': csrf },
      });
      expect(completeRes.statusCode).toBe(200);

      // 2b. Fail-closed readiness check: without live worker heartbeat or FFmpeg, API returns 503 and queues zero jobs
      const missingFfmpeg = await probeFfmpegAvailable('/nonexistent/ffmpeg-binary-check');
      expect(missingFfmpeg.ok).toBe(false);
      expect((await probeFfmpegAvailable()).ok).toBe(true);

      const noWorkerView = await app.inject({
        method: 'GET',
        url: `/api/v1/media/${mediaId}/view-token`,
        headers: { cookie: cookieB },
      });
      expect(noWorkerView.statusCode).toBe(503);
      expect(await redis.llen('queue:media:video:jobs')).toBe(0);

      await queue.publishHeartbeat('test-unhealthy-worker', { pid: process.pid, ffmpegOk: false, concurrency: 1 });
      expect(await queue.isHealthy()).toBe(false);
      const badFfmpegView = await app.inject({
        method: 'GET',
        url: `/api/v1/media/${mediaId}/view-token`,
        headers: { cookie: cookieB },
      });
      expect(badFfmpegView.statusCode).toBe(503);
      expect(await redis.llen('queue:media:video:jobs')).toBe(0);
      await queue.clearHeartbeat('test-unhealthy-worker');

      // Publish live healthy worker heartbeat -> readiness recovers
      await queue.publishHeartbeat('test-healthy-worker', { pid: process.pid, ffmpegOk: true, concurrency: 1 });
      const healthReport = await queue.getWorkerHealth();
      expect(healthReport.healthy).toBe(true);
      expect(healthReport.liveWorkers).toBe(1);
      expect(healthReport.ffmpegOk).toBe(true);

      // 3. First view-token request on cache miss returns 202 PROCESSING & enqueues deduped Redis job
      const firstView = await app.inject({
        method: 'GET',
        url: `/api/v1/media/${mediaId}/view-token`,
        headers: { cookie: cookieB },
      });
      expect(firstView.statusCode).toBe(202);
      expect(firstView.json().status).toBe('PROCESSING');
      expect(Number(firstView.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(await redis.llen('queue:media:video:jobs')).toBe(1);

      const secondView = await app.inject({
        method: 'GET',
        url: `/api/v1/media/${mediaId}/view-token`,
        headers: { cookie: cookieB },
      });
      expect(secondView.statusCode).toBe(202);
      expect(await redis.llen('queue:media:video:jobs')).toBe(1);

      // 4. Redis semaphore enforces global maxConcurrency = 1
      const slot1 = await queue.acquireSlot();
      expect(slot1).toBeTruthy();
      expect(await queue.acquireSlot()).toBeNull();
      await queue.releaseSlot(slot1!);
      const slot2 = await queue.acquireSlot();
      expect(slot2).toBeTruthy();
      await queue.releaseSlot(slot2!);

      // 5. Worker pops queued job, processes via FFmpeg on temp disk, encrypts & uploads variant via putStream
      const job = await queue.popBlocking(blockingRedis, 2);
      expect(job).toEqual({ mediaId, recipientId: userB });
      const workerResult = await worker.processJob(job!);
      expect(workerResult).toBe('READY');
      expect(putStreamCalls).toBe(1);

      const [variantRow] = await db
        .select()
        .from(mediaWatermarkedVariants)
        .where(and(eq(mediaWatermarkedVariants.mediaId, mediaId), eq(mediaWatermarkedVariants.recipientId, userB)));
      expect(variantRow?.status).toBe('READY');
      expect(objects.has(variantRow!.objectKey)).toBe(true);

      // 6. Cached READY variant returns 200 OK view-token and streams watermarked encrypted MP4
      const readyView = await app.inject({
        method: 'GET',
        url: `/api/v1/media/${mediaId}/view-token`,
        headers: { cookie: cookieB },
      });
      expect(readyView.statusCode).toBe(200);
      const viewData = readyView.json();
      expect(viewData.viewToken).toBeTruthy();
      expect(viewData.dek).toBeTruthy();
      expect(viewData.iv).toBeTruthy();
      expect(viewData.auth_tag).toBeTruthy();
      expect(viewData.content_type).toBe('video/mp4');

      const streamRes = await app.inject({
        method: 'GET',
        url: `/api/v1/media/stream/${mediaId}`,
        headers: {
          cookie: cookieB,
          'x-media-view-token': viewData.viewToken,
        },
      });
      expect(streamRes.statusCode).toBe(200);
      expect(streamRes.headers['x-media-watermarked']).toBe('embedded');

      const decipher = createDecipheriv(
        'aes-256-gcm',
        Buffer.from(viewData.dek, 'base64'),
        Buffer.from(viewData.iv, 'base64')
      );
      decipher.setAuthTag(Buffer.from(viewData.auth_tag, 'base64'));
      const streamedPlaintext = Buffer.concat([
        decipher.update(Buffer.from(streamRes.rawPayload)),
        decipher.final(),
      ]);
      expect(streamedPlaintext.subarray(4, 8).toString('ascii')).toBe('ftyp');
      expect(streamedPlaintext.equals(rawMp4)).toBe(false);
    } finally {
      await app.close();
      if (mediaId) {
        await queue.clearDedup({ mediaId, recipientId: userB });
      }
      await redis.del('queue:media:video:jobs', 'sem:media:video:active', 'health:media:workers');
      const hbKeys = await redis.keys('health:media:worker:*');
      if (hbKeys.length > 0) await redis.del(...hbKeys);
      await blockingRedis.quit();
      await redis.quit();
      await fs.rm(workDir, { recursive: true, force: true });
      const idsToDelete = [mediaId, spoofedMediaId].filter(Boolean);
      if (idsToDelete.length > 0) {
        await db.delete(mediaAssets).where(inArray(mediaAssets.id, idsToDelete));
      }
      await db.delete(chatSessions).where(eq(chatSessions.id, sessionId));
      await db.delete(users).where(inArray(users.id, [userA, userB]));
    }
  }, 30_000);
});

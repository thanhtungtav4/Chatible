import { execFile } from 'node:child_process';
import { createWriteStream, promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { MediaType } from './media.service.js';

// Keep libvips memory and native threads strictly bounded for 1 vCPU / 2 GB hosts.
sharp.cache(false);
sharp.concurrency(1);

export const MAX_IMAGE_WIDTH = 4096;
export const MAX_IMAGE_HEIGHT = 4096;
export const MAX_IMAGE_INPUT_PIXELS = 16_777_216; // 4096 * 4096 (~16.7 MP)
const parsedOutputEdge = Number.parseInt(process.env.WATERMARK_IMAGE_MAX_EDGE || '2048', 10);
export const MAX_IMAGE_OUTPUT_EDGE = Number.isFinite(parsedOutputEdge)
  ? Math.max(512, Math.min(2048, parsedOutputEdge))
  : 2048;

export class SharpProcessingSemaphore {
  private active = 0;
  private readonly waiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(
    readonly maxConcurrency = Math.max(1, Number.parseInt(process.env.SHARP_CONCURRENCY || '1', 10) || 1),
    readonly maxQueueLength = Math.max(1, Number.parseInt(process.env.SHARP_MAX_QUEUE || '16', 10) || 16),
    readonly waitTimeoutMs = Math.max(1000, Number.parseInt(process.env.SHARP_QUEUE_TIMEOUT_MS || '15000', 10) || 15_000)
  ) {}

  getStats(): { active: number; queued: number; maxConcurrency: number } {
    return { active: this.active, queued: this.waiters.length, maxConcurrency: this.maxConcurrency };
  }

  async acquire(): Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return;
    }
    if (this.waiters.length >= this.maxQueueLength) {
      throw new Error('IMAGE_PROCESSOR_BUSY');
    }
    await new Promise<void>((resolve, reject) => {
      const wrappedResolve = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === wrappedResolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error('IMAGE_PROCESSOR_BUSY'));
      }, this.waitTimeoutMs);
      this.waiters.push({ resolve: wrappedResolve, reject, timer });
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next.resolve();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

export const defaultImageSemaphore = new SharpProcessingSemaphore();

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isAsciiAt(buf: Buffer, offset: number, str: string): boolean {
  if (buf.length < offset + str.length) return false;
  return buf.subarray(offset, offset + str.length).toString('ascii') === str;
}

export function verifyMediaMagicBytes(
  buf: Buffer,
  expectedType: MediaType
): { ok: boolean; mime?: string } {
  if (buf.length < 12) return { ok: false };

  if (expectedType === 'IMAGE') {
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      return { ok: true, mime: 'image/jpeg' };
    }
    if (
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a
    ) {
      return { ok: true, mime: 'image/png' };
    }
    if (isAsciiAt(buf, 0, 'RIFF') && isAsciiAt(buf, 8, 'WEBP')) {
      return { ok: true, mime: 'image/webp' };
    }
    if (isAsciiAt(buf, 0, 'GIF87a') || isAsciiAt(buf, 0, 'GIF89a')) {
      return { ok: true, mime: 'image/gif' };
    }
    if (isAsciiAt(buf, 4, 'ftyp') && (isAsciiAt(buf, 8, 'avif') || isAsciiAt(buf, 8, 'heic'))) {
      return { ok: true, mime: 'image/avif' };
    }
    return { ok: false };
  }

  if (expectedType === 'VIDEO') {
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
      return { ok: true, mime: 'video/webm' };
    }
    if (isAsciiAt(buf, 4, 'ftyp') && !isAsciiAt(buf, 8, 'M4A ')) {
      return { ok: true, mime: 'video/mp4' };
    }
    return { ok: false };
  }

  if (expectedType === 'AUDIO') {
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
      return { ok: true, mime: 'audio/webm' };
    }
    if (isAsciiAt(buf, 4, 'ftyp')) {
      return { ok: true, mime: 'audio/mp4' };
    }
    if (isAsciiAt(buf, 0, 'OggS')) {
      return { ok: true, mime: 'audio/ogg' };
    }
    if (isAsciiAt(buf, 0, 'RIFF') && isAsciiAt(buf, 8, 'WAVE')) {
      return { ok: true, mime: 'audio/wav' };
    }
    if (isAsciiAt(buf, 0, 'fLaC')) {
      return { ok: true, mime: 'audio/flac' };
    }
    if (
      isAsciiAt(buf, 0, 'ID3') ||
      (buf[0] === 0xff && (buf[1] === 0xfb || buf[1] === 0xf3 || buf[1] === 0xf2 || buf[1] === 0xe3))
    ) {
      return { ok: true, mime: 'audio/mpeg' };
    }
    return { ok: false };
  }

  return { ok: false };
}

async function readValidatedImageDimensions(
  source: string | Buffer
): Promise<{ ok: boolean; width: number; height: number; reason?: string }> {
  try {
    const meta = await sharp(source, {
      limitInputPixels: MAX_IMAGE_INPUT_PIXELS,
      failOn: 'truncated',
    }).metadata();
    const swapped = (meta.orientation ?? 1) >= 5 && (meta.orientation ?? 1) <= 8;
    const width = swapped ? (meta.height ?? 0) : (meta.width ?? 0);
    const height = swapped ? (meta.width ?? 0) : (meta.height ?? 0);
    if (!width || !height) {
      return { ok: false, width: 0, height: 0, reason: 'Tệp ảnh không hợp lệ hoặc bị hỏng.' };
    }
    if (
      width > MAX_IMAGE_WIDTH ||
      height > MAX_IMAGE_HEIGHT ||
      width * height > MAX_IMAGE_INPUT_PIXELS
    ) {
      return {
        ok: false,
        width,
        height,
        reason: `Kích thước ảnh vượt quá giới hạn an toàn (${MAX_IMAGE_WIDTH}x${MAX_IMAGE_HEIGHT}, tối đa ${Math.round(MAX_IMAGE_INPUT_PIXELS / 1_000_000)}MP).`,
      };
    }
    return { ok: true, width, height };
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.toLowerCase().includes('pixel limit')) {
      return {
        ok: false,
        width: 0,
        height: 0,
        reason: `Tổng số pixel ảnh vượt quá giới hạn an toàn (${Math.round(MAX_IMAGE_INPUT_PIXELS / 1_000_000)}MP).`,
      };
    }
    return { ok: false, width: 0, height: 0, reason: 'Tệp ảnh không hợp lệ hoặc bị hỏng.' };
  }
}

export async function inspectImageDimensions(
  source: string | Buffer
): Promise<{ ok: boolean; width?: number; height?: number; reason?: string }> {
  const res = await readValidatedImageDimensions(source);
  return res.ok ? { ok: true, width: res.width, height: res.height } : { ok: false, reason: res.reason };
}

function buildWatermarkSvgOverlay(width: number, height: number, watermarkText: string): Buffer {
  const safeW = Math.max(width, 1);
  const safeH = Math.max(height, 1);
  const fontSize = Math.max(10, Math.min(26, Math.round(Math.min(safeW, safeH) / 18)));
  const safeText = escapeXml(watermarkText.slice(0, 80));

  const tileW = Math.max(160, safeText.length * Math.round(fontSize * 0.7) + 32);
  const tileH = Math.max(64, fontSize * 4);
  const badgeW = Math.max(16, Math.min(safeW - 8, safeText.length * Math.round(fontSize * 0.62) + 20));
  const badgeH = Math.min(safeH - 4, fontSize + 10);
  const badgeY = Math.max(2, safeH - badgeH - 4);

  return Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${safeW}" height="${safeH}">
      <defs>
        <pattern id="wm" width="${tileW}" height="${tileH}" patternUnits="userSpaceOnUse" patternTransform="rotate(-24)">
          <text x="10" y="${Math.round(tileH * 0.55)}"
            font-family="sans-serif"
            font-size="${fontSize}"
            font-weight="700"
            fill="rgba(255,255,255,0.34)"
            stroke="rgba(15,23,42,0.42)"
            stroke-width="1">${safeText}</text>
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#wm)" />
      ${
        safeW >= 40 && safeH >= 24
          ? `<rect x="4" y="${badgeY}" width="${badgeW}" height="${badgeH}" rx="6" fill="rgba(15,23,42,0.55)" />
             <text x="12" y="${Math.min(safeH - 6, badgeY + badgeH - 6)}" font-family="sans-serif" font-size="${Math.max(10, fontSize - 2)}" font-weight="700" fill="rgba(255,255,255,0.92)">${safeText}</text>`
          : ''
      }
    </svg>
  `);
}

/**
 * Strips sensitive EXIF/GPS metadata, enforces strict pixel/dimension caps,
 * downscales output to bounded HD dimensions, and permanently composites
 * repeating recipient trace watermark into image pixels via sharp.
 */
export async function burnImageWatermark(
  plaintextImage: Buffer | string,
  watermarkText: string
): Promise<{ buffer: Buffer; contentType: string }> {
  const bounds = await readValidatedImageDimensions(plaintextImage);
  if (!bounds.ok) {
    throw new Error(`IMAGE_DIMENSIONS_EXCEEDED:${bounds.reason ?? 'invalid'}`);
  }

  let basePipeline: ReturnType<typeof sharp>;
  let targetW = bounds.width;
  let targetH = bounds.height;

  if (bounds.width > MAX_IMAGE_OUTPUT_EDGE || bounds.height > MAX_IMAGE_OUTPUT_EDGE) {
    const resized = await sharp(plaintextImage, {
      limitInputPixels: MAX_IMAGE_INPUT_PIXELS,
      failOn: 'truncated',
    })
      .rotate()
      .resize({
        width: MAX_IMAGE_OUTPUT_EDGE,
        height: MAX_IMAGE_OUTPUT_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .png()
      .toBuffer({ resolveWithObject: true });
    targetW = resized.info.width;
    targetH = resized.info.height;
    basePipeline = sharp(resized.data, { limitInputPixels: MAX_IMAGE_INPUT_PIXELS });
  } else {
    basePipeline = sharp(plaintextImage, {
      limitInputPixels: MAX_IMAGE_INPUT_PIXELS,
      failOn: 'truncated',
    }).rotate();
  }

  const svgOverlay = buildWatermarkSvgOverlay(targetW, targetH, watermarkText);
  const output = await basePipeline
    .composite([{ input: svgOverlay, top: 0, left: 0 }])
    .webp({ quality: 84 })
    .toBuffer();

  return { buffer: output, contentType: 'image/webp' };
}

export async function burnImageWatermarkFile(
  inputPath: string,
  watermarkText: string
): Promise<{ buffer: Buffer; contentType: string }> {
  return burnImageWatermark(inputPath, watermarkText);
}

export async function probeFfmpegAvailable(
  bin = process.env.FFMPEG_PATH || 'ffmpeg'
): Promise<{ ok: boolean; version?: string; error?: string }> {
  return new Promise((resolve) => {
    execFile(
      bin,
      ['-version'],
      { timeout: 5_000, maxBuffer: 256 * 1024, killSignal: 'SIGKILL' },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false, error: error.message });
          return;
        }
        const firstLine = (stdout || '').split('\n', 1)[0]?.trim() || 'ffmpeg ok';
        resolve({ ok: true, version: firstLine });
      }
    );
  });
}

function runFfmpeg(args: string[], timeoutMs = 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const bin = process.env.FFMPEG_PATH || 'ffmpeg';
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, killSignal: 'SIGKILL' },
      (error) => {
        if (error) reject(error);
        else resolve();
      }
    );
  });
}

/**
 * Worker-only file-to-file FFmpeg watermark processor with strict single-thread
 * and hard timeout limits so host RAM/CPU stays bounded even for 100 MB videos.
 */
export async function burnVideoWatermarkFile(options: {
  inputPath: string;
  outputPath: string;
  mime: string;
  watermarkText: string;
  timeoutMs?: number;
  threads?: number;
}): Promise<boolean> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatible-wm-badge-'));
  const badgePath = path.join(workDir, 'badge.png');
  const ext = options.mime.includes('webm') ? 'webm' : 'mp4';
  const threads = String(Math.max(1, options.threads ?? 1));
  const timeoutMs = Math.max(5_000, options.timeoutMs ?? 60_000);

  try {
    const safeText = escapeXml(options.watermarkText.slice(0, 64));
    const badgeWidth = Math.min(480, Math.max(220, safeText.length * 9 + 28));
    const badgeSvg = Buffer.from(`
      <svg xmlns="http://www.w3.org/2000/svg" width="${badgeWidth}" height="32">
        <rect x="0" y="0" width="${badgeWidth}" height="32" rx="8" fill="rgba(15,23,42,0.62)" />
        <text x="12" y="21" font-family="sans-serif" font-size="14" font-weight="700" fill="rgba(255,255,255,0.92)">${safeText}</text>
      </svg>
    `);
    const badgePng = await sharp(badgeSvg).png().toBuffer();
    await fs.writeFile(badgePath, badgePng);

    const codecArgs =
      ext === 'webm'
        ? ['-c:v', 'libvpx', '-b:v', '800k', '-threads', threads, '-c:a', 'copy']
        : [
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            '-crf',
            '28',
            '-threads',
            threads,
            '-c:a',
            'copy',
            '-movflags',
            '+faststart',
          ];

    await runFfmpeg(
      [
        '-y',
        '-threads',
        threads,
        '-i',
        options.inputPath,
        '-i',
        badgePath,
        '-filter_complex',
        "[1:v]format=rgba[wm];[0:v][wm]overlay=x='if(eq(mod(floor(t/4),2),0),16,W-w-16)':y='if(eq(mod(floor(t/4),2),0),16,H-h-16)'",
        '-map_metadata',
        '-1',
        '-fs',
        '104857600',
        ...codecArgs,
        options.outputPath,
      ],
      timeoutMs
    );
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function* iterateBodyChunks(body: unknown, maxBytes: number): AsyncGenerator<Buffer> {
  if (Buffer.isBuffer(body)) {
    if (body.byteLength > maxBytes) throw new Error('Tệp vượt quá giới hạn kích thước cho phép.');
    yield body;
    return;
  }
  if (body instanceof Uint8Array) {
    if (body.byteLength > maxBytes) throw new Error('Tệp vượt quá giới hạn kích thước cho phép.');
    yield Buffer.from(body);
    return;
  }
  if (typeof body === 'string') {
    const b = Buffer.from(body);
    if (b.byteLength > maxBytes) throw new Error('Tệp vượt quá giới hạn kích thước cho phép.');
    yield b;
    return;
  }
  if (body && typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function') {
    let total = 0;
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.byteLength;
      if (total > maxBytes) {
        throw new Error('Tệp vượt quá giới hạn kích thước cho phép.');
      }
      if (buf.byteLength > 0) yield buf;
    }
    return;
  }
  if (body && typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray === 'function') {
    const arr = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
    if (arr.byteLength > maxBytes) throw new Error('Tệp vượt quá giới hạn kích thước cho phép.');
    yield Buffer.from(arr);
    return;
  }
  throw new Error('Không thể đọc luồng dữ liệu media.');
}

/**
 * Streams an encrypted object chunk-by-chunk through AES-256-GCM to verify the full AuthTag,
 * compute exact byte length, and check container magic bytes without loading 100 MB videos into RAM.
 */
export async function streamInspectAndVerifyEncryptedObject(input: {
  body: unknown;
  rawKey: Uint8Array;
  ivBase64: string;
  authTagBase64: string;
  expectedType: MediaType;
  maxPlaintextBytes: number;
  captureBuffer: boolean;
}): Promise<{ ok: boolean; mime?: string; totalBytes: number; plaintextBuffer: Buffer | null }> {
  const decipher = crypto.createDecipheriv('aes-256-gcm', input.rawKey, Buffer.from(input.ivBase64, 'base64'));
  decipher.setAuthTag(Buffer.from(input.authTagBase64, 'base64'));

  const headChunks: Buffer[] = [];
  let headBytesCount = 0;
  const fullChunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const cipherChunk of iterateBodyChunks(input.body, input.maxPlaintextBytes + 1024)) {
    const plainChunk = decipher.update(cipherChunk);
    if (plainChunk.byteLength > 0) {
      totalBytes += plainChunk.byteLength;
      if (totalBytes >= input.maxPlaintextBytes) {
        throw new Error('SIZE_LIMIT_EXCEEDED');
      }
      if (headBytesCount < 512) {
        const slice = plainChunk.subarray(0, 512 - headBytesCount);
        headChunks.push(slice);
        headBytesCount += slice.byteLength;
      }
      if (input.captureBuffer) {
        fullChunks.push(plainChunk);
      }
    }
  }

  const finalChunk = decipher.final();
  if (finalChunk.byteLength > 0) {
    totalBytes += finalChunk.byteLength;
    if (totalBytes >= input.maxPlaintextBytes) {
      throw new Error('SIZE_LIMIT_EXCEEDED');
    }
    if (headBytesCount < 512) {
      const slice = finalChunk.subarray(0, 512 - headBytesCount);
      headChunks.push(slice);
    }
    if (input.captureBuffer) {
      fullChunks.push(finalChunk);
    }
  }

  const headBuf = Buffer.concat(headChunks);
  const magic = verifyMediaMagicBytes(headBuf, input.expectedType);
  return {
    ok: magic.ok,
    mime: magic.mime,
    totalBytes,
    plaintextBuffer: input.captureBuffer ? Buffer.concat(fullChunks) : null,
  };
}

export async function streamDecryptToFile(input: {
  body: unknown;
  rawKey: Uint8Array;
  ivBase64: string;
  authTagBase64: string;
  outPath: string;
  maxBytes: number;
}): Promise<number> {
  const decipher = crypto.createDecipheriv('aes-256-gcm', input.rawKey, Buffer.from(input.ivBase64, 'base64'));
  decipher.setAuthTag(Buffer.from(input.authTagBase64, 'base64'));

  const ws = createWriteStream(input.outPath);
  let totalBytes = 0;

  const writeChunk = (buf: Buffer) =>
    new Promise<void>((resolve, reject) => {
      if (ws.write(buf)) resolve();
      else ws.once('drain', resolve).once('error', reject);
    });

  try {
    for await (const cipherChunk of iterateBodyChunks(input.body, input.maxBytes + 1024)) {
      const plain = decipher.update(cipherChunk);
      if (plain.byteLength > 0) {
        totalBytes += plain.byteLength;
        await writeChunk(plain);
      }
    }
    const finalBuf = decipher.final();
    if (finalBuf.byteLength > 0) {
      totalBytes += finalBuf.byteLength;
      await writeChunk(finalBuf);
    }
    await new Promise<void>((resolve, reject) => {
      ws.on('error', reject);
      ws.end(() => resolve());
    });
    return totalBytes;
  } catch (err) {
    ws.destroy();
    await fs.unlink(input.outPath).catch(() => {});
    throw err;
  }
}

export async function streamEncryptFileToTemp(input: {
  inputPath: string;
  encryptedOutPath: string;
  rawKey: Uint8Array;
}): Promise<{ iv: string; authTag: string; encryptedSize: number; plaintextSize: number }> {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', input.rawKey, iv);
  const { createReadStream } = await import('node:fs');
  const rs = createReadStream(input.inputPath, { highWaterMark: 64 * 1024 });
  const ws = createWriteStream(input.encryptedOutPath);

  let plaintextSize = 0;
  let encryptedSize = 0;

  const writeChunk = (buf: Buffer) =>
    new Promise<void>((resolve, reject) => {
      if (ws.write(buf)) resolve();
      else ws.once('drain', resolve).once('error', reject);
    });

  try {
    for await (const chunk of rs) {
      const buf = chunk as Buffer;
      plaintextSize += buf.byteLength;
      const enc = cipher.update(buf);
      if (enc.byteLength > 0) {
        encryptedSize += enc.byteLength;
        await writeChunk(enc);
      }
    }
    const finalBuf = cipher.final();
    if (finalBuf.byteLength > 0) {
      encryptedSize += finalBuf.byteLength;
      await writeChunk(finalBuf);
    }
    await new Promise<void>((resolve, reject) => {
      ws.on('error', reject);
      ws.end(() => resolve());
    });
    return {
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      encryptedSize,
      plaintextSize,
    };
  } catch (err) {
    rs.destroy();
    ws.destroy();
    await fs.unlink(input.encryptedOutPath).catch(() => {});
    throw err;
  }
}

export function encryptBufferAesGcm(plaintext: Buffer, rawKey: Uint8Array): { ciphertext: Buffer; iv: string; authTag: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', rawKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext,
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptBufferAesGcm(ciphertext: Buffer, rawKey: Uint8Array, ivBase64: string, authTagBase64: string): Buffer {
  const decipher = crypto.createDecipheriv('aes-256-gcm', rawKey, Buffer.from(ivBase64, 'base64'));
  decipher.setAuthTag(Buffer.from(authTagBase64, 'base64'));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export async function readableToBuffer(body: unknown, maxBytes: number): Promise<Buffer> {
  if (Buffer.isBuffer(body)) {
    if (body.byteLength > maxBytes) throw new Error('Tệp vượt quá giới hạn kích thước cho phép.');
    return body;
  }
  if (body instanceof Uint8Array) {
    if (body.byteLength > maxBytes) throw new Error('Tệp vượt quá giới hạn kích thước cho phép.');
    return Buffer.from(body);
  }
  if (typeof body === 'string') {
    const b = Buffer.from(body);
    if (b.byteLength > maxBytes) throw new Error('Tệp vượt quá giới hạn kích thước cho phép.');
    return b;
  }
  if (body && typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray === 'function') {
    const arr = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
    if (arr.byteLength > maxBytes) throw new Error('Tệp vượt quá giới hạn kích thước cho phép.');
    return Buffer.from(arr);
  }
  if (body && typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.byteLength;
      if (total > maxBytes) {
        throw new Error('Tệp vượt quá giới hạn kích thước cho phép.');
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  }
  throw new Error('Không thể đọc luồng dữ liệu media.');
}

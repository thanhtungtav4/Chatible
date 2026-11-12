import { describe, expect, it } from 'bun:test';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fastify from 'fastify';
import sharp from 'sharp';
import { JwtUtil } from '../auth/jwt.util.js';
import { config } from '../config/env.js';
import { MediaController } from './media.controller.js';
import { LocalKmsService } from '../kms/local-kms.service.js';
import { SharpProcessingSemaphore } from './media-processing.util.js';
import { MediaService } from './media.service.js';
import type {
  AdultConsentRow,
  MediaAssetRow,
  MediaConsentRow,
  MediaObjectStore,
  MediaRepository,
  MediaStatus,
  MediaTokenRow,
  MediaWatermarkedVariantRow,
  SessionRow,
} from './media.service.js';

const owner = '11111111-1111-4111-8111-111111111111';
const recipient = '22222222-2222-4222-8222-222222222222';
const sessionId = '33333333-3333-4333-8333-333333333333';
const plaintextDek = Buffer.alloc(32, 0x5a);
const dek = plaintextDek.toString('base64');
const fileIv = Buffer.alloc(12, 0x3c).toString('base64');
const fileAuthTag = Buffer.alloc(16, 0x7d).toString('base64');

async function buildEncryptedTestWebp(): Promise<{
  rawWebp: Buffer;
  ciphertext: Buffer;
  fileSize: number;
  ivBase64: string;
  authTagBase64: string;
}> {
  const rawWebp = await sharp({
    create: { width: 64, height: 64, channels: 4, background: { r: 24, g: 119, b: 242, alpha: 1 } },
  })
    .webp()
    .toBuffer();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', plaintextDek, iv);
  const ciphertext = Buffer.concat([cipher.update(rawWebp), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    rawWebp,
    ciphertext,
    fileSize: ciphertext.length,
    ivBase64: iv.toString('base64'),
    authTagBase64: tag.toString('base64'),
  };
}

class FakeRepository implements MediaRepository {
  session: SessionRow = { id: sessionId, userAId: owner, userBId: recipient, expiresAt: new Date(Date.now() + 86_400_000), status: 'ACTIVE' };
  assets = new Map<string, MediaAssetRow>();
  consents = new Map<string, MediaConsentRow>();
  adultConsents = new Map<string, AdultConsentRow>();
  tokens = new Map<string, MediaTokenRow>();
  async getSession(id: string) { return id === sessionId ? this.session : null; }
  async getAsset(id: string) { return this.assets.get(id) ?? null; }
  async insertAsset(asset: MediaAssetRow) { this.assets.set(asset.id, asset); }
  async updateAssetStatus(
    id: string,
    patch: { status: MediaStatus; fileSize?: number; verifiedMime?: string; finalizedAt?: Date }
  ) {
    const asset = this.assets.get(id);
    if (!asset) return;
    asset.status = patch.status;
    if (patch.fileSize !== undefined) asset.fileSize = patch.fileSize;
    if (patch.verifiedMime !== undefined) asset.verifiedMime = patch.verifiedMime;
    if (patch.finalizedAt !== undefined) asset.finalizedAt = patch.finalizedAt;
  }
  async listExpiredAssets(now: Date) {
    return [...this.assets.values()]
      .filter((asset) => {
        if (asset.revokedAt || asset.expiresAt.getTime() <= now.getTime()) return true;
        return asset.status === 'PENDING_UPLOAD' && now.getTime() - asset.createdAt.getTime() > 15 * 60 * 1000;
      })
      .map(({ id, sessionId: assetSessionId, objectKey }) => ({ id, sessionId: assetSessionId, objectKey }));
  }
  async deleteAsset(id: string) { this.assets.delete(id); }
  async getConsent(s: string, r: string) { return this.consents.get(`${s}:${r}`) ?? null; }
  async upsertConsent(s: string, r: string, enabled: boolean) { this.consents.set(`${s}:${r}`, { sessionId: s, recipientId: r, enabled }); }
  async getAdultConsent(s: string, r: string) { return this.adultConsents.get(`${s}:${r}`) ?? null; }
  async upsertAdultConsent(s: string, r: string, enabled: boolean, policyAcknowledged: boolean) {
    this.adultConsents.set(`${s}:${r}`, { sessionId: s, recipientId: r, enabled, policyAcknowledged });
  }
  async areFriends() { return false; }
  async isBlocked() { return false; }
  async getSafeRecipientLabel(userId: string) { return userId === recipient ? 'Người nhận' : 'Người xem'; }
  async insertToken(token: MediaTokenRow) { this.tokens.set(token.tokenHash, token); }
  async getToken(hash: string) { return this.tokens.get(hash) ?? null; }
  async revokeAsset(id: string, at: Date) { const asset = this.assets.get(id); if (asset) asset.revokedAt = at; for (const token of this.tokens.values()) if (token.mediaId === id) token.revokedAt = at; }
  evidenceMediaIds = new Set<string>();
  async isEvidence(id: string) { return this.evidenceMediaIds.has(id); }
}

class FakeStorage implements MediaObjectStore {
  objects = new Map<string, { body: Buffer; contentType: string }>();
  failDelete = false;
  async presignPut(input: { key: string; contentType: string }) {
    if (!this.objects.has(input.key)) {
      this.objects.set(input.key, { body: Buffer.from('ciphertext'), contentType: input.contentType });
    }
    return `https://storage.test/${input.key}`;
  }
  putObject(key: string, body: Buffer, contentType = 'application/octet-stream') {
    this.objects.set(key, { body, contentType });
  }
  async exists(key: string) { return this.objects.has(key); }
  async head(key: string) {
    const obj = this.objects.get(key);
    if (!obj) return { exists: false };
    return { exists: true, contentLength: obj.body.length, contentType: obj.contentType };
  }
  async get(key: string) {
    const obj = this.objects.get(key);
    if (!obj) throw new Error('missing object');
    return { body: obj.body, contentType: obj.contentType, contentLength: obj.body.length };
  }
  async delete(key: string) { if (this.failDelete) throw new Error('delete failed'); this.objects.delete(key); }
}

describe('MediaService authorization and revocation', () => {
  function setup() {
    const repository = new FakeRepository();
    const storage = new FakeStorage();
    const kms = new LocalKmsService('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
    return { repository, storage, kms, service: new MediaService({ repository, storage, kms }) };
  }

  it('requires recipient consent before presigning an upload', async () => {
    const { service } = setup();
    await expect(service.presignUpload(owner, { sessionId, recipientId: recipient, contentType: 'image/webp', fileSize: 10, mediaType: 'IMAGE', dek, iv: fileIv, authTag: fileAuthTag })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('enforces the product media limits and rejects mismatched declared media types', async () => {
    const { service } = setup();
    await service.setConsent(recipient, sessionId, true);
    const base = { sessionId, recipientId: recipient, dek, iv: fileIv, authTag: fileAuthTag };

    await expect(
      service.presignUpload(owner, { ...base, contentType: 'image/webp', fileSize: 30_000_000, mediaType: 'IMAGE' })
    ).rejects.toMatchObject({ statusCode: 413 });
    await expect(
      service.presignUpload(owner, { ...base, contentType: 'video/mp4', fileSize: 100_000_000, mediaType: 'VIDEO' })
    ).rejects.toMatchObject({ statusCode: 413 });
    await expect(
      service.presignUpload(owner, { ...base, contentType: 'video/mp4', fileSize: 10, mediaType: 'IMAGE' })
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      service.presignUpload(owner, { ...base, contentType: 'image/webp', fileSize: 29_999_999, mediaType: 'IMAGE' })
    ).resolves.toMatchObject({ mediaId: expect.any(String) });
  });

  it('binds upload and viewing to session participants, enforces upload finalize, and burns pixel watermark on image streams', async () => {
    const { service, repository, storage, kms } = setup();
    await service.setConsent(recipient, sessionId, true);
    const sample = await buildEncryptedTestWebp();
    const upload = await service.presignUpload(owner, {
      sessionId,
      recipientId: recipient,
      contentType: 'image/webp',
      fileSize: sample.fileSize,
      mediaType: 'IMAGE',
      dek,
      iv: sample.ivBase64,
      authTag: sample.authTagBase64,
    });
    const storedAsset = repository.assets.get(upload.mediaId)!;
    const wrappedDek = Buffer.from(storedAsset.encryptedDek, 'base64');
    expect(wrappedDek).toHaveLength(60);
    expect(wrappedDek.equals(plaintextDek)).toBe(false);
    expect(Buffer.from(await kms.unwrapKey(wrappedDek)).equals(plaintextDek)).toBe(true);
    const wrongKms = new LocalKmsService('abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789');
    await expect(wrongKms.unwrapKey(wrappedDek)).rejects.toThrow();

    // Before completeUpload, view tokens MUST be rejected with 409
    await expect(service.issueViewToken(recipient, upload.mediaId)).rejects.toMatchObject({ statusCode: 409 });

    storage.putObject(storedAsset.objectKey, sample.ciphertext);
    const completed = await service.completeUpload(owner, upload.mediaId);
    expect(completed).toMatchObject({ mediaId: upload.mediaId, status: 'READY', verifiedMime: 'image/webp' });

    await expect(service.issueViewToken('99999999-9999-4999-8999-999999999999', upload.mediaId)).rejects.toMatchObject({ statusCode: 403 });
    const token = await service.issueViewToken(recipient, upload.mediaId);
    // Images use a fresh per-view stream DEK rather than exposing the raw stored asset DEK
    expect(token.dek).not.toBe(dek);
    expect(token.expiresIn).toBe(300);
    expect(token.watermarkText).toContain('Chatible');

    const stream = await service.openStream(recipient, upload.mediaId, token.viewToken);
    expect(stream.contentType).toBe('application/octet-stream');
    expect(stream.watermarked).toBe(true);
    expect(stream.iv).toBeTruthy();
    expect(stream.authTag).toBeTruthy();

    const decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(token.dek, 'base64'),
      Buffer.from(stream.iv!, 'base64')
    );
    decipher.setAuthTag(Buffer.from(stream.authTag!, 'base64'));
    const decryptedWebp = Buffer.concat([decipher.update(stream.body), decipher.final()]);
    const meta = await sharp(decryptedWebp).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(64);
    expect(meta.height).toBe(64);
    // Watermark altered pixel data so decrypted output differs from raw upload
    expect(decryptedWebp.equals(sample.rawWebp)).toBe(false);
  });

  it('deletes expired objects and preserves metadata when storage deletion fails', async () => {
    const { service, repository, storage } = setup();
    await service.setConsent(recipient, sessionId, true);
    const upload = await service.presignUpload(owner, { sessionId, recipientId: recipient, contentType: 'image/webp', fileSize: 10, mediaType: 'IMAGE', dek, iv: fileIv, authTag: fileAuthTag });
    const asset = repository.assets.get(upload.mediaId)!;
    asset.expiresAt = new Date(Date.now() - 1);
    storage.failDelete = true;
    const failed = await service.cleanupExpiredAssets();
    expect(failed).toMatchObject({ deletedCount: 0, failedSessionIds: [sessionId] });
    expect(repository.assets.has(upload.mediaId)).toBe(true);
    expect(storage.objects.has(asset.objectKey)).toBe(true);

    storage.failDelete = false;
    const cleaned = await service.cleanupExpiredAssets();
    expect(cleaned).toMatchObject({ deletedCount: 1, failedSessionIds: [] });
    expect(repository.assets.has(upload.mediaId)).toBe(false);
    expect(storage.objects.has(asset.objectKey)).toBe(false);
  });
  it('revokes view tokens and deletes the object immediately', async () => {
    const { service, repository, storage } = setup();
    await service.setConsent(recipient, sessionId, true);
    const sample = await buildEncryptedTestWebp();
    const upload = await service.presignUpload(owner, {
      sessionId,
      recipientId: recipient,
      contentType: 'image/webp',
      fileSize: sample.fileSize,
      mediaType: 'IMAGE',
      dek,
      iv: sample.ivBase64,
      authTag: sample.authTagBase64,
    });
    const asset = repository.assets.get(upload.mediaId)!;
    storage.putObject(asset.objectKey, sample.ciphertext);
    await service.completeUpload(owner, upload.mediaId);

    const expiredToken = await service.issueViewToken(recipient, upload.mediaId);
    [...repository.tokens.values()][0]!.expiresAt = new Date(Date.now() - 1);
    await expect(service.openStream(recipient, upload.mediaId, expiredToken.viewToken)).rejects.toMatchObject({ statusCode: 403 });

    const freshToken = await service.issueViewToken(recipient, upload.mediaId);
    await service.revoke(owner, upload.mediaId);
    expect(storage.objects.has(asset.objectKey)).toBe(false);
    await expect(service.issueViewToken(recipient, upload.mediaId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.openStream(recipient, upload.mediaId, freshToken.viewToken)).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.revoke(recipient, upload.mediaId)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('preserves the storage object upon revocation if the media is retained as report evidence', async () => {
    const { service, repository, storage } = setup();
    await service.setConsent(recipient, sessionId, true);
    const upload = await service.presignUpload(owner, { sessionId, recipientId: recipient, contentType: 'image/webp', fileSize: 10, mediaType: 'IMAGE', dek, iv: fileIv, authTag: fileAuthTag });
    const asset = repository.assets.get(upload.mediaId)!;

    repository.evidenceMediaIds.add(upload.mediaId);

    await service.revoke(owner, upload.mediaId);
    expect(storage.objects.has(asset.objectKey)).toBe(true);
    await expect(service.issueViewToken(recipient, upload.mediaId)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects spoofed magic bytes or corrupted payloads during completeUpload and removes orphan objects', async () => {
    const { service, repository, storage } = setup();
    await service.setConsent(recipient, sessionId, true);
    const bogusBytes = Buffer.from('not-a-real-webp-file-payload');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', plaintextDek, iv);
    const ciphertext = Buffer.concat([cipher.update(bogusBytes), cipher.final()]);
    const tag = cipher.getAuthTag();

    const upload = await service.presignUpload(owner, {
      sessionId,
      recipientId: recipient,
      contentType: 'image/webp',
      fileSize: ciphertext.length,
      mediaType: 'IMAGE',
      dek,
      iv: iv.toString('base64'),
      authTag: tag.toString('base64'),
    });
    const asset = repository.assets.get(upload.mediaId)!;
    storage.putObject(asset.objectKey, ciphertext);

    await expect(service.completeUpload(owner, upload.mediaId)).rejects.toMatchObject({ statusCode: 415 });
    expect(repository.assets.get(upload.mediaId)?.status).toBe('FAILED');
    expect(storage.objects.has(asset.objectKey)).toBe(false);
  });

  it('enforces explicit recipient 18+ consent, policy acknowledgment, and sender commitments for adult media', async () => {
    const { service, repository, storage } = setup();
    await service.setConsent(recipient, sessionId, true);
    const sample = await buildEncryptedTestWebp();

    // Adult policy acknowledgment is required when enabling adult consent
    await expect(service.setAdultConsent(recipient, sessionId, true, false)).rejects.toMatchObject({ statusCode: 400 });

    // Adult upload fails until recipient explicitly grants 18+ consent
    await expect(
      service.presignUpload(owner, {
        sessionId,
        recipientId: recipient,
        contentType: 'image/webp',
        fileSize: sample.fileSize,
        mediaType: 'IMAGE',
        dek,
        iv: sample.ivBase64,
        authTag: sample.authTagBase64,
        isAdult: true,
        senderConfirmed18Plus: true,
        senderConfirmedConsent: true,
      })
    ).rejects.toMatchObject({ statusCode: 403 });

    await service.setAdultConsent(recipient, sessionId, true, true);

    // Adult AUDIO is forbidden even with adult consent enabled
    await expect(
      service.presignUpload(owner, {
        sessionId,
        recipientId: recipient,
        contentType: 'audio/webm',
        fileSize: 100,
        mediaType: 'AUDIO',
        dek,
        iv: fileIv,
        authTag: fileAuthTag,
        isAdult: true,
        senderConfirmed18Plus: true,
        senderConfirmedConsent: true,
      })
    ).rejects.toMatchObject({ statusCode: 400 });

    // Adult upload still fails unless sender confirms both 18+ age & mutual consent
    await expect(
      service.presignUpload(owner, {
        sessionId,
        recipientId: recipient,
        contentType: 'image/webp',
        fileSize: sample.fileSize,
        mediaType: 'IMAGE',
        dek,
        iv: sample.ivBase64,
        authTag: sample.authTagBase64,
        isAdult: true,
        senderConfirmed18Plus: true,
        senderConfirmedConsent: false,
      })
    ).rejects.toMatchObject({ statusCode: 400 });

    const adultUpload = await service.presignUpload(owner, {
      sessionId,
      recipientId: recipient,
      contentType: 'image/webp',
      fileSize: sample.fileSize,
      mediaType: 'IMAGE',
      dek,
      iv: sample.ivBase64,
      authTag: sample.authTagBase64,
      isAdult: true,
      senderConfirmed18Plus: true,
      senderConfirmedConsent: true,
    });
    const asset = repository.assets.get(adultUpload.mediaId)!;
    storage.putObject(asset.objectKey, sample.ciphertext);
    await service.completeUpload(owner, adultUpload.mediaId);

    // Verify deliverable succeeds when adult, fails if claimed non-adult mismatch
    const verified = await service.verifyDeliverableMedia({
      mediaId: adultUpload.mediaId,
      sessionId,
      senderId: owner,
      recipientId: recipient,
      mediaType: 'IMAGE',
      isAdultContent: true,
    });
    expect(verified.isAdult).toBe(true);

    // Revoking adult consent blocks subsequent view token issuance even if standard media consent stays enabled
    await service.setAdultConsent(recipient, sessionId, false, false);
    await expect(service.issueViewToken(recipient, adultUpload.mediaId)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('requires authentication on upload, token, stream, and revoke endpoints', async () => {
    const { service, storage, repository } = setup();
    const app = fastify({ logger: false });
    new MediaController(service).registerRoutes(app);
    await app.ready();

    try {
      const unauthorized = await Promise.all([
        app.inject({ method: 'POST', url: '/api/v1/media/presign-upload', payload: {} }),
        app.inject({ method: 'GET', url: `/api/v1/media/${crypto.randomUUID()}/view-token` }),
        app.inject({ method: 'GET', url: `/api/v1/media/stream/${crypto.randomUUID()}?token=arbitrary-token` }),
        app.inject({ method: 'POST', url: `/api/v1/media/${crypto.randomUUID()}/revoke` }),
      ]);
      expect(unauthorized.map((response) => response.statusCode)).toEqual([401, 401, 401, 401]);

      const ownerToken = JwtUtil.sign({ sub: owner, email: 'owner@example.test' }, config.jwtSecret);
      const recipientToken = JwtUtil.sign({ sub: recipient, email: 'recipient@example.test' }, config.jwtSecret);
      const ownerCookie = `chatible_session=${encodeURIComponent(ownerToken)}`;
      const recipientCookie = `chatible_session=${encodeURIComponent(recipientToken)}`;
      await service.setConsent(recipient, sessionId, true);

      // Cookie-only web enforcement: Bearer header must fail 401
      const bearerDenied = await app.inject({
        method: 'POST',
        url: '/api/v1/media/presign-upload',
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {},
      });
      expect(bearerDenied.statusCode).toBe(401);

      const sample = await buildEncryptedTestWebp();
      const upload = await app.inject({
        method: 'POST',
        url: '/api/v1/media/presign-upload',
        headers: { cookie: ownerCookie },
        payload: {
          sessionId,
          recipientId: recipient,
          contentType: 'image/webp',
          fileSize: sample.fileSize,
          mediaType: 'IMAGE',
          dek,
          iv: sample.ivBase64,
          authTag: sample.authTagBase64,
        },
      });
      expect(upload.statusCode).toBe(200);
      const mediaId = upload.json().media_id as string;
      storage.putObject(repository.assets.get(mediaId)!.objectKey, sample.ciphertext);

      const completeRes = await app.inject({
        method: 'POST',
        url: `/api/v1/media/${mediaId}/complete`,
        headers: { cookie: ownerCookie },
      });
      expect(completeRes.statusCode).toBe(200);
      expect(completeRes.json()).toMatchObject({ mediaId, status: 'READY', verifiedMime: 'image/webp' });

      const viewToken = await app.inject({
        method: 'GET',
        url: `/api/v1/media/${mediaId}/view-token`,
        headers: { cookie: recipientCookie },
      });
      expect(viewToken.statusCode).toBe(200);
      expect(viewToken.json()).toMatchObject({ expires_in: 300 });
      expect(viewToken.json().dek).toBeTruthy();
      expect(viewToken.json().dek).not.toBe(dek);
      expect(viewToken.json()).not.toHaveProperty('encrypted_dek');
      expect(viewToken.headers['cache-control']).toBe('private, no-store');
      const rawViewToken = viewToken.json().view_token as string;

      const queryTokenStream = await app.inject({
        method: 'GET',
        url: `/api/v1/media/stream/${mediaId}?token=${encodeURIComponent(rawViewToken)}`,
        headers: { cookie: recipientCookie },
      });
      expect(queryTokenStream.statusCode).toBe(401);
      const stream = await app.inject({
        method: 'GET',
        url: `/api/v1/media/stream/${mediaId}`,
        headers: {
          cookie: recipientCookie,
          'x-media-view-token': rawViewToken,
        },
      });
      expect(stream.statusCode).toBe(200);
      expect(stream.headers['x-media-watermarked']).toBe('embedded');
      expect(stream.headers['x-media-iv']).toBeTruthy();
      expect(stream.headers['x-media-auth-tag']).toBeTruthy();
      const revoke = await app.inject({
        method: 'POST',
        url: `/api/v1/media/${mediaId}/revoke`,
        headers: { cookie: ownerCookie },
      });
      expect(revoke.statusCode).toBe(200);
      expect(revoke.json()).toMatchObject({ revoked: true });
    } finally {
      await app.close();
    }
  });

  it('rejects oversized image dimensions (>4096px) at completeUpload with 415 and cleans up storage', async () => {
    const { service, repository, storage } = setup();
    await service.setConsent(recipient, sessionId, true);

    const wideWebp = await sharp({
      create: { width: 4200, height: 16, channels: 4, background: { r: 220, g: 38, b: 38, alpha: 1 } },
    })
      .webp()
      .toBuffer();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', plaintextDek, iv);
    const ciphertext = Buffer.concat([cipher.update(wideWebp), cipher.final()]);
    const tag = cipher.getAuthTag();

    const upload = await service.presignUpload(owner, {
      sessionId,
      recipientId: recipient,
      contentType: 'image/webp',
      fileSize: ciphertext.length,
      mediaType: 'IMAGE',
      dek,
      iv: iv.toString('base64'),
      authTag: tag.toString('base64'),
    });
    const asset = repository.assets.get(upload.mediaId)!;
    storage.putObject(asset.objectKey, ciphertext);

    await expect(service.completeUpload(owner, upload.mediaId)).rejects.toMatchObject({ statusCode: 415 });
    expect(storage.objects.has(asset.objectKey)).toBe(false);
    expect(repository.assets.get(upload.mediaId)?.status).toBe('FAILED');
  });

  it('caches per-recipient watermarked image variants and rejects overflow with 503 via SharpProcessingSemaphore', async () => {
    class CachingRepo extends FakeRepository {
      variants = new Map<string, MediaWatermarkedVariantRow>();
      async getWatermarkedVariant(mId: string, rId: string) {
        return this.variants.get(`${mId}:${rId}`) ?? null;
      }
      async upsertWatermarkedVariant(v: Omit<MediaWatermarkedVariantRow, 'id'>) {
        this.variants.set(`${v.mediaId}:${v.recipientId}`, { id: `${v.mediaId}:${v.recipientId}`, ...v });
      }
    }
    class StreamFakeStorage extends FakeStorage {
      putStreamCalls = 0;
      getKeys: string[] = [];
      async putStream(input: { key: string; body: NodeJS.ReadableStream | Buffer; contentType: string }) {
        this.putStreamCalls += 1;
        const buf = Buffer.isBuffer(input.body)
          ? input.body
          : await (async () => {
              const chunks: Buffer[] = [];
              for await (const c of input.body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
              return Buffer.concat(chunks);
            })();
        this.objects.set(input.key, { body: buf, contentType: input.contentType });
      }
      override async get(key: string) {
        this.getKeys.push(key);
        return super.get(key);
      }
    }

    const repository = new CachingRepo();
    const storage = new StreamFakeStorage();
    const kms = new LocalKmsService('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
    const sem = new SharpProcessingSemaphore(1, 1, 2_000);
    const service = new MediaService({ repository, storage, kms, imageSemaphore: sem });
    await service.setConsent(recipient, sessionId, true);

    const sample = await buildEncryptedTestWebp();
    const upload = await service.presignUpload(owner, {
      sessionId,
      recipientId: recipient,
      contentType: 'image/webp',
      fileSize: sample.fileSize,
      mediaType: 'IMAGE',
      dek,
      iv: sample.ivBase64,
      authTag: sample.authTagBase64,
    });
    const asset = repository.assets.get(upload.mediaId)!;
    storage.putObject(asset.objectKey, sample.ciphertext);
    await service.completeUpload(owner, upload.mediaId);

    // 1st view populates variant cache via Sharp under semaphore
    const tok1 = await service.issueViewToken(recipient, upload.mediaId);
    const stream1 = await service.openStream(recipient, upload.mediaId, tok1.viewToken);
    expect(stream1.watermarked).toBe(true);
    expect(storage.putStreamCalls).toBe(1);
    const cachedVariant = await repository.getWatermarkedVariant(upload.mediaId, recipient);
    expect(cachedVariant?.status).toBe('READY');

    // 2nd view serves straight from cached variant without touching Sharp or original asset key
    storage.getKeys = [];
    const tok2 = await service.issueViewToken(recipient, upload.mediaId);
    expect(tok2.dek).toBe(tok1.dek);
    const stream2 = await service.openStream(recipient, upload.mediaId, tok2.viewToken);
    expect(stream2.watermarked).toBe(true);
    expect(storage.putStreamCalls).toBe(1);
    expect(storage.getKeys).toEqual([cachedVariant!.objectKey]);

    // Backpressure test: uncached image while semaphore is saturated (1 active + 1 queued) returns 503
    const upload2 = await service.presignUpload(owner, {
      sessionId,
      recipientId: recipient,
      contentType: 'image/webp',
      fileSize: sample.fileSize,
      mediaType: 'IMAGE',
      dek,
      iv: sample.ivBase64,
      authTag: sample.authTagBase64,
    });
    storage.putObject(repository.assets.get(upload2.mediaId)!.objectKey, sample.ciphertext);
    await service.completeUpload(owner, upload2.mediaId);
    const tA = await service.issueViewToken(recipient, upload2.mediaId);
    const tB = await service.issueViewToken(recipient, upload2.mediaId);

    await sem.acquire();
    const queuedPromise = service.openStream(recipient, upload2.mediaId, tA.viewToken);
    await new Promise((r) => setTimeout(r, 25));
    expect(sem.getStats()).toEqual({ active: 1, queued: 1, maxConcurrency: 1 });
    await expect(service.openStream(recipient, upload2.mediaId, tB.viewToken)).rejects.toMatchObject({ statusCode: 503 });
    sem.release();
    const resumed = await queuedPromise;
    expect(resumed.watermarked).toBe(true);
  });
});

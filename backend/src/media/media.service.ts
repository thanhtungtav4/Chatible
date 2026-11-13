import crypto from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IKmsProvider } from '@chatible/shared';
import { createConfiguredKms } from '../kms/cloud-kms.service.js';
import {
  burnImageWatermarkFile,
  defaultImageSemaphore,
  encryptBufferAesGcm,
  inspectImageDimensions,
  SharpProcessingSemaphore,
  streamDecryptToFile,
  streamInspectAndVerifyEncryptedObject,
  verifyMediaMagicBytes,
} from './media-processing.util.js';
import type { VideoWatermarkQueue } from './media-queue.service.js';
import {
  CONTENT_TYPE_PREFIX,
  MEDIA_SIZE_LABEL,
  MEDIA_SIZE_LIMIT_BYTES,
  MediaError,
  MediaProcessingPendingError,
  type MediaAssetRow,
  type MediaObjectStore,
  type MediaRepository,
  type MediaStatus,
  type MediaType,
} from './media.types.js';
import { createDefaultMediaRepository } from './media.repository.js';
import { createDefaultObjectStore } from './media.object-store.js';
import { MediaPolicyHelper } from './media-policy.service.js';

export * from './media.types.js';
export { createDefaultMediaRepository } from './media.repository.js';
export { S3ObjectStore, createDefaultObjectStore } from './media.object-store.js';

export interface MediaServiceOptions {
  repository?: MediaRepository;
  storage?: MediaObjectStore;
  kms?: IKmsProvider;
  videoQueue?: VideoWatermarkQueue;
  imageSemaphore?: SharpProcessingSemaphore;
}

export class MediaService {
  private readonly repository: MediaRepository;
  private readonly storage: MediaObjectStore;
  private readonly kms: IKmsProvider;
  private readonly videoQueue?: VideoWatermarkQueue;
  private readonly imageSemaphore: SharpProcessingSemaphore;
  private readonly policy: MediaPolicyHelper;

  constructor(options: MediaServiceOptions = {}) {
    this.repository = options.repository ?? createDefaultMediaRepository();
    this.storage = options.storage ?? createDefaultObjectStore();
    this.kms = options.kms ?? createConfiguredKms().kms;
    this.videoQueue = options.videoQueue;
    this.imageSemaphore = options.imageSemaphore ?? defaultImageSemaphore;
    this.policy = new MediaPolicyHelper(this.repository);
  }

  async hasMediaConsent(sessionId: string, recipientId: string): Promise<boolean> {
    return this.policy.consentIsValid(sessionId, recipientId);
  }

  async hasAdultConsent(sessionId: string, recipientId: string): Promise<boolean> {
    return this.policy.adultConsentIsValid(sessionId, recipientId);
  }

  async setConsent(userId: string, sessionId: string, enabled: boolean, requestedRecipientId?: string): Promise<void> {
    return this.policy.setConsent(userId, sessionId, enabled, requestedRecipientId);
  }

  async setAdultConsent(
    userId: string,
    sessionId: string,
    enabled: boolean,
    policyAcknowledged = false,
    requestedRecipientId?: string
  ): Promise<void> {
    return this.policy.setAdultConsent(userId, sessionId, enabled, policyAcknowledged, requestedRecipientId);
  }

  async getConsentState(
    userId: string,
    sessionId: string
  ): Promise<{
    myMediaConsent: boolean;
    partnerMediaConsent: boolean;
    myAdultConsent: boolean;
    partnerAdultConsent: boolean;
  }> {
    return this.policy.getConsentState(userId, sessionId);
  }

  async cleanupExpiredAssets(now: Date = new Date()): Promise<{ deletedCount: number; failedCount: number; failedSessionIds: string[] }> {
    const candidates = await this.repository.listExpiredAssets(now);
    const failedSessionIds = new Set<string>();
    let deletedCount = 0;
    let failedCount = 0;
    for (const asset of candidates) {
      if (await this.repository.isEvidence(asset.id)) {
        continue;
      }
      try {
        const variants = (await this.repository.listWatermarkedVariantsForMedia?.(asset.id)) ?? [];
        for (const variant of variants) {
          if (variant.objectKey) {
            await this.storage.delete(variant.objectKey).catch(() => {});
          }
        }
        await this.storage.delete(asset.objectKey);
        await this.repository.deleteAsset(asset.id);
        deletedCount += 1;
      } catch (error) {
        failedCount += 1;
        failedSessionIds.add(asset.sessionId);
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`[MediaCleanup] Could not remove expired asset ${asset.id}: ${reason}`);
      }
    }
    return { deletedCount, failedCount, failedSessionIds: [...failedSessionIds] };
  }

  async presignUpload(
    userId: string,
    input: {
      sessionId: string;
      recipientId: string;
      contentType: string;
      fileSize: number;
      mediaType: MediaType;
      dek: string;
      iv: string;
      authTag: string;
      isAdult?: boolean;
      senderConfirmed18Plus?: boolean;
      senderConfirmedConsent?: boolean;
    }
  ): Promise<{ mediaId: string; uploadUrl: string; expiresAt: Date }> {
    await this.policy.assertUserActive(userId);
    const session = await this.policy.sessionForParticipant(input.sessionId, userId);
    if (session.sessionType === 'RANDOM' && session.status !== 'ACTIVE') {
      throw new MediaError(409, 'Phiên chat ngẫu nhiên đã kết thúc.');
    }
    if (input.recipientId === userId || input.recipientId !== this.policy.otherParticipant(session, userId)) {
      throw new MediaError(403, 'Người nhận không thuộc phiên trò chuyện này.');
    }
    await this.policy.assertNotBlocked(userId, input.recipientId);

    if (!(await this.policy.consentIsValid(input.sessionId, input.recipientId, session))) {
      throw new MediaError(403, 'Người nhận chưa bật quyền nhận media.');
    }

    if (!['IMAGE', 'AUDIO', 'VIDEO'].includes(input.mediaType)) {
      throw new MediaError(400, 'Loại media không hợp lệ.');
    }

    const isAdult = input.isAdult === true;
    const confirmed18Plus = input.senderConfirmed18Plus === true;
    const confirmedConsent = input.senderConfirmedConsent === true;
    if (isAdult) {
      if (input.mediaType === 'AUDIO') {
        throw new MediaError(400, 'Nội dung 18+ chỉ hỗ trợ định dạng ảnh hoặc video.');
      }
      if (!confirmed18Plus || !confirmedConsent) {
        throw new MediaError(
          400,
          'Gửi nội dung người lớn bắt buộc phải xác nhận người xuất hiện từ 18+ và có sự đồng thuận hợp pháp.'
        );
      }
      if (!(await this.policy.adultConsentIsValid(input.sessionId, input.recipientId))) {
        throw new MediaError(403, 'Đối phương chưa bật quyền nhận nội dung nhạy cảm (18+).');
      }
    }
    if (!Number.isInteger(input.fileSize) || input.fileSize < 1 || input.fileSize >= MEDIA_SIZE_LIMIT_BYTES[input.mediaType]) {
      throw new MediaError(413, MEDIA_SIZE_LABEL[input.mediaType]);
    }
    if (!/^(image|audio|video)\/[a-z0-9.+-]+$/i.test(input.contentType)) {
      throw new MediaError(400, 'Content-Type media không hợp lệ.');
    }
    if (!input.contentType.toLowerCase().startsWith(CONTENT_TYPE_PREFIX[input.mediaType])) {
      throw new MediaError(400, 'Content-Type không khớp với loại media.');
    }

    const mediaDek = Buffer.from(input.dek, 'base64');
    const fileIv = Buffer.from(input.iv, 'base64');
    const fileAuthTag = Buffer.from(input.authTag, 'base64');
    if (
      mediaDek.length !== 32 ||
      mediaDek.toString('base64') !== input.dek ||
      fileIv.length !== 12 ||
      fileAuthTag.length !== 16
    ) {
      mediaDek.fill(0);
      throw new MediaError(400, 'Media key envelope không hợp lệ.');
    }

    let encryptedDek: string;
    try {
      encryptedDek = Buffer.from(await this.kms.wrapKey(mediaDek)).toString('base64');
    } finally {
      mediaDek.fill(0);
    }

    const mediaId = crypto.randomUUID();
    const objectKey = `media/${input.sessionId}/${mediaId}/${crypto.randomBytes(16).toString('hex')}`;
    const expiresAt =
      session.sessionType === 'FRIEND'
        ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        : session.expiresAt;

    const asset: MediaAssetRow = {
      id: mediaId,
      sessionId: input.sessionId,
      ownerId: userId,
      recipientId: input.recipientId,
      objectKey,
      mediaType: input.mediaType,
      contentType: input.contentType,
      fileSize: input.fileSize,
      encryptedDek,
      iv: input.iv,
      authTag: input.authTag,
      status: 'PENDING_UPLOAD',
      verifiedMime: null,
      finalizedAt: null,
      isAdult,
      senderConfirmed18Plus: confirmed18Plus,
      senderConfirmedConsent: confirmedConsent,
      watermarkToken: crypto.randomBytes(24).toString('hex'),
      createdAt: new Date(),
      expiresAt,
      revokedAt: null,
    };

    const uploadUrl = await this.storage.presignPut({
      key: objectKey,
      contentType: input.contentType,
      contentLength: input.fileSize,
      mediaId,
    });
    await this.repository.insertAsset(asset);
    return { mediaId, uploadUrl, expiresAt };
  }

  private async failAndDeleteUpload(asset: MediaAssetRow, reasonError: MediaError): Promise<never> {
    await this.storage.delete(asset.objectKey).catch(() => {});
    if (this.repository.updateAssetStatus) {
      await this.repository.updateAssetStatus(asset.id, { status: 'FAILED' }).catch(() => {});
    }
    throw reasonError;
  }

  /**
   * Verifies that the encrypted blob really exists in object storage, decrypts it with KMS DEK,
   * verifies authentic byte length & magic bytes, and transitions status to READY.
   */
  async completeUpload(
    userId: string,
    mediaId: string
  ): Promise<{ mediaId: string; status: MediaStatus; fileSize: number; verifiedMime: string }> {
    await this.policy.assertUserActive(userId);
    const asset = await this.repository.getAsset(mediaId);
    if (!asset || asset.revokedAt || asset.expiresAt.getTime() <= Date.now()) {
      throw new MediaError(404, 'Media không tồn tại hoặc đã hết hạn.');
    }
    if (asset.ownerId !== userId) {
      throw new MediaError(403, 'Chỉ người tải lên mới có quyền hoàn tất media.');
    }
    if (asset.status === 'READY' && asset.verifiedMime) {
      return {
        mediaId: asset.id,
        status: 'READY',
        fileSize: asset.fileSize,
        verifiedMime: asset.verifiedMime,
      };
    }
    if (asset.status !== 'PENDING_UPLOAD') {
      throw new MediaError(409, 'Trạng thái tải lên media không hợp lệ.');
    }

    const session = await this.policy.sessionForParticipant(asset.sessionId, userId);
    if (session.sessionType === 'RANDOM' && session.status !== 'ACTIVE') {
      return this.failAndDeleteUpload(asset, new MediaError(409, 'Phiên chat đã kết thúc trong lúc tải media.'));
    }
    await this.policy.assertNotBlocked(asset.ownerId, asset.recipientId);

    if (!(await this.policy.consentIsValid(asset.sessionId, asset.recipientId, session))) {
      return this.failAndDeleteUpload(asset, new MediaError(403, 'Người nhận đã tắt quyền nhận media.'));
    }
    if (asset.isAdult && !(await this.policy.adultConsentIsValid(asset.sessionId, asset.recipientId))) {
      return this.failAndDeleteUpload(asset, new MediaError(403, 'Người nhận đã tắt quyền nhận nội dung 18+.'));
    }

    const headInfo = this.storage.head
      ? await this.storage.head(asset.objectKey)
      : { exists: await this.storage.exists(asset.objectKey), contentLength: undefined };

    if (!headInfo.exists) {
      return this.failAndDeleteUpload(asset, new MediaError(400, 'Tệp media chưa được tải lên kho lưu trữ.'));
    }

    const mediaType = asset.mediaType as MediaType;
    const limit = MEDIA_SIZE_LIMIT_BYTES[mediaType];
    if (headInfo.contentLength !== undefined && (headInfo.contentLength < 12 || headInfo.contentLength > limit + 1024)) {
      return this.failAndDeleteUpload(asset, new MediaError(413, MEDIA_SIZE_LABEL[mediaType]));
    }

    let rawDek: Uint8Array | null = null;
    let workDir: string | null = null;
    try {
      const obj = await this.storage.get(asset.objectKey);
      rawDek = await this.kms.unwrapKey(Buffer.from(asset.encryptedDek, 'base64'));
      let totalBytes = 0;
      let verifiedMime: string | undefined;

      if (mediaType === 'IMAGE') {
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatible-img-fin-'));
        const plainImgPath = path.join(workDir, 'payload');
        totalBytes = await streamDecryptToFile({
          body: obj.body,
          rawKey: rawDek,
          ivBase64: asset.iv,
          authTagBase64: asset.authTag,
          outPath: plainImgPath,
          maxBytes: limit,
        });
        if (totalBytes < 12 || totalBytes >= limit) {
          return await this.failAndDeleteUpload(asset, new MediaError(413, MEDIA_SIZE_LABEL[mediaType]));
        }
        const fh = await fs.open(plainImgPath, 'r');
        let headBuf: Buffer;
        try {
          headBuf = Buffer.alloc(Math.min(512, totalBytes));
          await fh.read(headBuf, 0, headBuf.length, 0);
        } finally {
          await fh.close();
        }
        const magic = verifyMediaMagicBytes(headBuf, 'IMAGE');
        if (!magic.ok || !magic.mime) {
          return await this.failAndDeleteUpload(
            asset,
            new MediaError(415, 'Định dạng thực tế của tệp không khớp với loại media hợp lệ.')
          );
        }
        const dims = await this.imageSemaphore.run(() => inspectImageDimensions(plainImgPath));
        if (!dims.ok) {
          return await this.failAndDeleteUpload(
            asset,
            new MediaError(415, dims.reason || 'Tệp ảnh không hợp lệ hoặc vượt quá giới hạn pixel an toàn.')
          );
        }
        verifiedMime = magic.mime;
      } else {
        const inspected = await streamInspectAndVerifyEncryptedObject({
          body: obj.body,
          rawKey: rawDek,
          ivBase64: asset.iv,
          authTagBase64: asset.authTag,
          expectedType: mediaType,
          maxPlaintextBytes: limit,
          captureBuffer: false,
        });
        totalBytes = inspected.totalBytes;
        if (totalBytes < 12 || totalBytes >= limit) {
          return await this.failAndDeleteUpload(asset, new MediaError(413, MEDIA_SIZE_LABEL[mediaType]));
        }
        if (!inspected.ok || !inspected.mime) {
          return await this.failAndDeleteUpload(
            asset,
            new MediaError(415, 'Định dạng thực tế của tệp không khớp với loại media hợp lệ.')
          );
        }
        verifiedMime = inspected.mime;
      }

      const finalizedAt = new Date();
      if (this.repository.updateAssetStatus) {
        await this.repository.updateAssetStatus(asset.id, {
          status: 'READY',
          fileSize: totalBytes,
          verifiedMime,
          finalizedAt,
        });
      }

      return {
        mediaId: asset.id,
        status: 'READY',
        fileSize: totalBytes,
        verifiedMime,
      };
    } catch (err) {
      if (err instanceof MediaError) throw err;
      if (err instanceof Error && err.message === 'IMAGE_PROCESSOR_BUSY') {
        throw new MediaError(503, 'Máy chủ đang bận kiểm tra hình ảnh, vui lòng thử lại sau.');
      }
      if (
        err instanceof Error &&
        (err.message === 'SIZE_LIMIT_EXCEEDED' || err.message.includes('giới hạn kích thước'))
      ) {
        return this.failAndDeleteUpload(asset, new MediaError(413, MEDIA_SIZE_LABEL[mediaType]));
      }
      return this.failAndDeleteUpload(
        asset,
        new MediaError(400, 'Không thể xác thực toàn vẹn dữ liệu media đã tải lên.')
      );
    } finally {
      if (workDir) {
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
      if (rawDek) Buffer.from(rawDek).fill(0);
    }
  }

  async saveLocalUpload(key: string, body: Buffer): Promise<void> {
    if (this.storage.putStream) {
      await this.storage.putStream({
        key,
        body,
        contentType: 'application/octet-stream',
        contentLength: body.length,
      });
    } else {
      throw new MediaError(500, 'Kho lưu trữ hiện tại không hỗ trợ tải tệp trực tiếp.');
    }
  }

  /**
   * Gateway & Friends verification guard ensuring a chat media message binds to a READY,
   * unrevoked, authorized asset with matching mediaType and adult flag.
   */
  async verifyDeliverableMedia(input: {
    mediaId: string;
    sessionId: string;
    senderId: string;
    recipientId: string;
    mediaType: MediaType;
    isAdultContent: boolean;
  }): Promise<MediaAssetRow> {
    return this.policy.verifyDeliverableMedia(input);
  }

  async issueViewToken(
    userId: string,
    mediaId: string
  ): Promise<{
    viewToken: string;
    dek: string;
    watermarkText: string;
    traceCode: string;
    expiresIn: number;
    expiresAt: Date;
    contentType: string;
    mediaType: string;
    iv: string;
    authTag: string;
  }> {
    await this.policy.assertUserActive(userId);
    const asset = await this.repository.getAsset(mediaId);
    if (!asset || asset.revokedAt || asset.expiresAt.getTime() <= Date.now()) {
      throw new MediaError(404, 'Media không tồn tại hoặc đã hết hạn.');
    }
    if (asset.status !== 'READY') {
      throw new MediaError(409, 'Media chưa sẵn sàng để xem.');
    }
    const session = await this.policy.sessionForParticipant(asset.sessionId, userId);
    if (session.userAId !== asset.ownerId && session.userBId !== asset.ownerId) {
      throw new MediaError(403, 'Media không thuộc phiên hợp lệ.');
    }
    if (userId !== asset.ownerId && userId !== asset.recipientId) {
      throw new MediaError(403, 'Bạn không có quyền xem media này.');
    }
    await this.policy.assertNotBlocked(asset.ownerId, asset.recipientId);

    if (!(await this.policy.consentIsValid(asset.sessionId, asset.recipientId, session))) {
      throw new MediaError(403, 'Quyền nhận media đã bị thu hồi.');
    }
    if (asset.isAdult && !(await this.policy.adultConsentIsValid(asset.sessionId, asset.recipientId))) {
      throw new MediaError(403, 'Quyền nhận nội dung nhạy cảm (18+) đã bị thu hồi.');
    }
    if (!(await this.storage.exists(asset.objectKey))) {
      throw new MediaError(404, 'Media chưa được tải lên đầy đủ.');
    }

    const safeLabel = this.repository.getSafeRecipientLabel
      ? await this.repository.getSafeRecipientLabel(userId)
      : 'Người xem';
    const traceCode = `WT-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const watermarkText = `Chatible • @${safeLabel} • #${traceCode}`;
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const rawToken = `mvt_${crypto.randomBytes(32).toString('base64url')}`;
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    if (asset.mediaType === 'AUDIO') {
      const rawDek = await this.kms.unwrapKey(Buffer.from(asset.encryptedDek, 'base64'));
      try {
        if (rawDek.length !== 32) throw new MediaError(500, 'Không thể mở khóa media.');
        const dek = Buffer.from(rawDek).toString('base64');
        await this.repository.insertToken({
          mediaId,
          recipientId: userId,
          tokenHash,
          traceCode,
          watermarkText,
          streamKeyWrapped: null,
          expiresAt,
          revokedAt: null,
        });
        return {
          viewToken: rawToken,
          dek,
          watermarkText,
          traceCode,
          expiresIn: 300,
          expiresAt,
          contentType: asset.verifiedMime || asset.contentType,
          mediaType: asset.mediaType,
          iv: asset.iv,
          authTag: asset.authTag,
        };
      } finally {
        Buffer.from(rawDek).fill(0);
      }
    }

    if (asset.mediaType === 'VIDEO') {
      const cachedToken = await this.tryIssueCachedVariantToken({
        mediaId,
        userId,
        rawToken,
        tokenHash,
        expiresAt,
        mediaType: asset.mediaType,
      });
      if (cachedToken) return cachedToken;

      if (!this.repository.upsertWatermarkedVariant || !this.videoQueue) {
        throw new MediaError(503, 'Dịch vụ xử lý watermark video nền chưa sẵn sàng.');
      }
      if (typeof this.videoQueue.isHealthy === 'function' && !(await this.videoQueue.isHealthy())) {
        throw new MediaError(
          503,
          'Dịch vụ xử lý video nền (Media Worker/FFmpeg) hiện không khả dụng. Vui lòng thử lại sau.'
        );
      }

      const existingVariant = await this.repository.getWatermarkedVariant?.(mediaId, userId);
      const staleAgeMs = existingVariant?.updatedAt ? Date.now() - existingVariant.updatedAt.getTime() : Infinity;
      const shouldEnqueue =
        !existingVariant ||
        existingVariant.status === 'FAILED' ||
        (existingVariant.status === 'PENDING' && staleAgeMs > 15_000) ||
        (existingVariant.status === 'PROCESSING' && staleAgeMs > 120_000) ||
        (existingVariant.status === 'READY' && !(await this.storage.exists(existingVariant.objectKey)));

      if (shouldEnqueue) {
        const recipientHash = crypto.createHash('sha256').update(userId).digest('hex').slice(0, 16);
        await this.repository.upsertWatermarkedVariant({
          mediaId,
          recipientId: userId,
          objectKey: `media-variants/${asset.sessionId}/${mediaId}/${recipientHash}.enc`,
          encryptedDek: '',
          iv: '',
          authTag: '',
          contentType: asset.verifiedMime || asset.contentType,
          fileSize: asset.fileSize,
          traceCode,
          watermarkText,
          status: 'PENDING',
          error: null,
          expiresAt: asset.expiresAt,
        });
        await this.videoQueue.enqueue({ mediaId, recipientId: userId });
      }

      throw new MediaProcessingPendingError(
        1500,
        'Video đang được xử lý đóng dấu watermark ở worker nền. Vui lòng chờ...'
      );
    }

    if (asset.mediaType === 'IMAGE') {
      const cachedImageToken = await this.tryIssueCachedVariantToken({
        mediaId,
        userId,
        rawToken,
        tokenHash,
        expiresAt,
        mediaType: asset.mediaType,
      });
      if (cachedImageToken) return cachedImageToken;
    }

    // IMAGE cache miss uses a dedicated per-view DEK which is also persisted to the recipient cache once rendered.
    const viewDek = crypto.randomBytes(32);
    try {
      const wrappedStreamKey = Buffer.from(await this.kms.wrapKey(viewDek)).toString('base64');
      await this.repository.insertToken({
        mediaId,
        recipientId: userId,
        tokenHash,
        traceCode,
        watermarkText,
        streamKeyWrapped: wrappedStreamKey,
        expiresAt,
        revokedAt: null,
      });
      return {
        viewToken: rawToken,
        dek: viewDek.toString('base64'),
        watermarkText,
        traceCode,
        expiresIn: 300,
        expiresAt,
        contentType: asset.mediaType === 'IMAGE' ? 'image/webp' : asset.verifiedMime || asset.contentType,
        mediaType: asset.mediaType,
        iv: asset.iv,
        authTag: asset.authTag,
      };
    } finally {
      viewDek.fill(0);
    }
  }

  private async tryIssueCachedVariantToken(input: {
    mediaId: string;
    userId: string;
    rawToken: string;
    tokenHash: string;
    expiresAt: Date;
    mediaType: string;
  }) {
    const existingVariant = await this.repository.getWatermarkedVariant?.(input.mediaId, input.userId);
    if (
      !existingVariant ||
      existingVariant.status !== 'READY' ||
      existingVariant.expiresAt.getTime() <= Date.now() ||
      !existingVariant.objectKey ||
      !(await this.storage.exists(existingVariant.objectKey))
    ) {
      return null;
    }

    const rawVariantDek = await this.kms.unwrapKey(Buffer.from(existingVariant.encryptedDek, 'base64'));
    try {
      if (rawVariantDek.length !== 32) {
        throw new MediaError(500, 'Không thể mở khóa bản sao media.');
      }
      await this.repository.insertToken({
        mediaId: input.mediaId,
        recipientId: input.userId,
        tokenHash: input.tokenHash,
        traceCode: existingVariant.traceCode,
        watermarkText: existingVariant.watermarkText,
        streamKeyWrapped: existingVariant.encryptedDek,
        expiresAt: input.expiresAt,
        revokedAt: null,
      });
      return {
        viewToken: input.rawToken,
        dek: Buffer.from(rawVariantDek).toString('base64'),
        watermarkText: existingVariant.watermarkText,
        traceCode: existingVariant.traceCode,
        expiresIn: 300,
        expiresAt: input.expiresAt,
        contentType: existingVariant.contentType,
        mediaType: input.mediaType,
        iv: existingVariant.iv,
        authTag: existingVariant.authTag,
      };
    } finally {
      Buffer.from(rawVariantDek).fill(0);
    }
  }

  private async tryOpenCachedVariantStream(
    mediaId: string,
    userId: string,
    expectedWrappedKey?: string | null
  ) {
    const variant = await this.repository.getWatermarkedVariant?.(mediaId, userId);
    if (
      !variant ||
      variant.status !== 'READY' ||
      variant.expiresAt.getTime() <= Date.now() ||
      !variant.objectKey ||
      (expectedWrappedKey && variant.encryptedDek !== expectedWrappedKey) ||
      !(await this.storage.exists(variant.objectKey))
    ) {
      return null;
    }
    const cachedObj = await this.storage.get(variant.objectKey);
    return {
      body: cachedObj.body,
      contentType: 'application/octet-stream',
      contentLength: variant.fileSize,
      iv: variant.iv,
      authTag: variant.authTag,
      mediaContentType: variant.contentType,
      watermarked: true,
    };
  }

  async openStream(
    userId: string,
    mediaId: string,
    rawToken: string
  ): Promise<{
    body: unknown;
    contentType: string;
    contentLength?: number;
    iv?: string;
    authTag?: string;
    mediaContentType?: string;
    watermarked?: boolean;
  }> {
    await this.policy.assertUserActive(userId);
    if (!rawToken || rawToken.length < 20) throw new MediaError(401, 'View token không hợp lệ.');
    const token = await this.repository.getToken(crypto.createHash('sha256').update(rawToken).digest('hex'));
    const asset = await this.repository.getAsset(mediaId);
    if (
      !token ||
      !asset ||
      token.mediaId !== mediaId ||
      token.recipientId !== userId ||
      token.revokedAt ||
      token.expiresAt.getTime() <= Date.now()
    ) {
      throw new MediaError(403, 'View token đã hết hạn hoặc không được cấp cho tài khoản này.');
    }
    if (asset.status !== 'READY') {
      throw new MediaError(409, 'Media chưa hoàn tất xác thực.');
    }
    const session = await this.policy.sessionForParticipant(asset.sessionId, userId);
    if (session.userAId !== userId && session.userBId !== userId) {
      throw new MediaError(403, 'Bạn không thuộc phiên trò chuyện này.');
    }
    await this.policy.assertNotBlocked(asset.ownerId, asset.recipientId);

    if (asset.revokedAt || asset.expiresAt.getTime() <= Date.now()) {
      throw new MediaError(403, 'Media đã bị thu hồi hoặc hết hạn.');
    }
    if (!(await this.policy.consentIsValid(asset.sessionId, asset.recipientId, session))) {
      throw new MediaError(403, 'Quyền nhận media đã bị thu hồi.');
    }
    if (asset.isAdult && !(await this.policy.adultConsentIsValid(asset.sessionId, asset.recipientId))) {
      throw new MediaError(403, 'Quyền nhận nội dung nhạy cảm (18+) đã bị thu hồi.');
    }

    if (asset.mediaType === 'VIDEO') {
      const cachedVideo = await this.tryOpenCachedVariantStream(mediaId, userId);
      if (!cachedVideo) {
        throw new MediaError(409, 'Video đã xử lý không tồn tại hoặc đang được worker tạo lại.');
      }
      return cachedVideo;
    }

    if (asset.mediaType === 'AUDIO' || !token.streamKeyWrapped) {
      const object = await this.storage.get(asset.objectKey);
      return {
        body: object.body,
        contentType: 'application/octet-stream',
        contentLength: object.contentLength,
        iv: asset.iv,
        authTag: asset.authTag,
        mediaContentType: asset.verifiedMime || asset.contentType,
        watermarked: false,
      };
    }

    // IMAGE cache hit avoids decrypting 30 MB blobs or invoking Sharp completely.
    const cachedImage = await this.tryOpenCachedVariantStream(mediaId, userId, token.streamKeyWrapped);
    if (cachedImage) {
      return cachedImage;
    }

    // IMAGE cache miss: stream-decrypt original ciphertext to temp disk -> bounded pixel watermark under Sharp semaphore -> cache variant.
    const limit = MEDIA_SIZE_LIMIT_BYTES.IMAGE;
    const object = await this.storage.get(asset.objectKey);
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatible-img-wm-'));
    const plainImgPath = path.join(workDir, 'plain');
    let assetDek: Uint8Array | null = null;
    let streamDek: Uint8Array | null = null;
    try {
      assetDek = await this.kms.unwrapKey(Buffer.from(asset.encryptedDek, 'base64'));
      streamDek = await this.kms.unwrapKey(Buffer.from(token.streamKeyWrapped, 'base64'));
      await streamDecryptToFile({
        body: object.body,
        rawKey: assetDek,
        ivBase64: asset.iv,
        authTagBase64: asset.authTag,
        outPath: plainImgPath,
        maxBytes: limit,
      });

      const wmText = token.watermarkText || `Chatible • #${asset.watermarkToken.slice(0, 12)}`;
      const wmImage = await this.imageSemaphore.run(() => burnImageWatermarkFile(plainImgPath, wmText));
      const reEncrypted = encryptBufferAesGcm(wmImage.buffer, streamDek);

      if (this.storage.putStream && this.repository.upsertWatermarkedVariant) {
        const recipientHash = crypto.createHash('sha256').update(userId).digest('hex').slice(0, 16);
        const variantKey = `media-variants/${asset.sessionId}/${mediaId}/${recipientHash}.enc`;
        await this.storage.putStream({
          key: variantKey,
          body: reEncrypted.ciphertext,
          contentType: 'application/octet-stream',
          contentLength: reEncrypted.ciphertext.byteLength,
        });
        await this.repository.upsertWatermarkedVariant({
          mediaId,
          recipientId: userId,
          objectKey: variantKey,
          encryptedDek: token.streamKeyWrapped,
          iv: reEncrypted.iv,
          authTag: reEncrypted.authTag,
          contentType: wmImage.contentType,
          fileSize: reEncrypted.ciphertext.byteLength,
          traceCode: token.traceCode || `WT-${asset.watermarkToken.slice(0, 8).toUpperCase()}`,
          watermarkText: wmText,
          status: 'READY',
          error: null,
          expiresAt: asset.expiresAt,
        });
      }

      return {
        body: reEncrypted.ciphertext,
        contentType: 'application/octet-stream',
        contentLength: reEncrypted.ciphertext.byteLength,
        iv: reEncrypted.iv,
        authTag: reEncrypted.authTag,
        mediaContentType: wmImage.contentType,
        watermarked: true,
      };
    } catch (err) {
      if (err instanceof MediaError) throw err;
      const msg = err instanceof Error ? err.message : '';
      if (msg === 'IMAGE_PROCESSOR_BUSY') {
        throw new MediaError(503, 'Máy chủ đang bận xử lý hình ảnh, vui lòng thử lại sau.');
      }
      if (msg.startsWith('IMAGE_DIMENSIONS_EXCEEDED:')) {
        throw new MediaError(415, msg.slice('IMAGE_DIMENSIONS_EXCEEDED:'.length) || 'Kích thước ảnh vượt quá giới hạn an toàn.');
      }
      throw new MediaError(500, 'Không thể xử lý đóng dấu ảnh an toàn.');
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      if (assetDek) Buffer.from(assetDek).fill(0);
      if (streamDek) Buffer.from(streamDek).fill(0);
    }
  }

  /**
   * MOD-08 / D25: Streams decrypted media to Admin via authenticated temp disk file (< 1 MB RAM),
   * cleaning temp file automatically once response finishes.
   */
  async decryptMediaForAdmin(mediaId: string): Promise<{
    stream: NodeJS.ReadableStream;
    fileSize: number;
    contentType: string;
    mediaType: string;
    isAdult: boolean;
    revokedAt: Date | null;
    sessionId: string;
    ownerId: string;
    recipientId: string;
  }> {
    const asset = await this.repository.getAsset(mediaId);
    if (!asset) {
      throw new MediaError(404, 'Không tìm thấy tài sản media hoặc đã bị xóa theo hạn lưu trữ.');
    }
    if (asset.status !== 'READY') {
      throw new MediaError(409, 'Media này chưa hoàn tất tải lên.');
    }
    const obj = await this.storage.get(asset.objectKey);
    const limit = MEDIA_SIZE_LIMIT_BYTES[asset.mediaType as MediaType] ?? 100_000_000;
    const rawDek = await this.kms.unwrapKey(Buffer.from(asset.encryptedDek, 'base64'));
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatible-adm-media-'));
    const plainPath = path.join(workDir, 'payload');
    try {
      const fileSize = await streamDecryptToFile({
        body: obj.body,
        rawKey: rawDek,
        ivBase64: asset.iv,
        authTagBase64: asset.authTag,
        outPath: plainPath,
        maxBytes: limit,
      });
      const stream = createReadStream(plainPath);
      const cleanup = () => {
        void fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      };
      stream.once('close', cleanup);
      stream.once('error', cleanup);
      return {
        stream,
        fileSize,
        contentType: asset.verifiedMime || asset.contentType,
        mediaType: asset.mediaType,
        isAdult: asset.isAdult,
        revokedAt: asset.revokedAt,
        sessionId: asset.sessionId,
        ownerId: asset.ownerId,
        recipientId: asset.recipientId,
      };
    } catch (err) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    } finally {
      Buffer.from(rawDek).fill(0);
    }
  }

  async getMediaStatus(
    userId: string,
    mediaId: string
  ): Promise<{ mediaId: string; status: string; revoked: boolean; expired: boolean }> {
    await this.policy.assertUserActive(userId);
    const asset = await this.repository.getAsset(mediaId);
    if (!asset) throw new MediaError(404, 'Media không tồn tại.');
    if (asset.ownerId !== userId && asset.recipientId !== userId) {
      throw new MediaError(403, 'Bạn không có quyền truy cập trạng thái media này.');
    }
    return {
      mediaId: asset.id,
      status: asset.status,
      revoked: Boolean(asset.revokedAt),
      expired: asset.expiresAt.getTime() <= Date.now(),
    };
  }

  async revoke(userId: string, mediaId: string): Promise<void> {
    await this.policy.assertUserActive(userId);
    const asset = await this.repository.getAsset(mediaId);
    if (!asset) throw new MediaError(404, 'Media không tồn tại.');
    if (asset.ownerId !== userId) throw new MediaError(403, 'Chỉ người gửi mới có thể thu hồi media.');
    if (!asset.revokedAt) await this.repository.revokeAsset(mediaId, new Date());
    const isEvidence = await this.repository.isEvidence(mediaId);
    if (!isEvidence) {
      const variants = (await this.repository.listWatermarkedVariantsForMedia?.(mediaId)) ?? [];
      for (const variant of variants) {
        if (variant.objectKey) {
          await this.storage.delete(variant.objectKey).catch(() => {});
        }
      }
      await this.storage.delete(asset.objectKey);
    }
  }
}

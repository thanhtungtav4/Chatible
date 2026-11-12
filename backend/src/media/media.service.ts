import crypto from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { and, eq, isNotNull, lt, lte, or, sql } from 'drizzle-orm';
import { db } from '../database/index.js';
import { chatSessions } from '../database/schema/sessions.js';
import { adultConsents, mediaAssets, mediaConsents, mediaViewTokens, mediaWatermarkedVariants } from '../database/schema/media.js';
import { messages } from '../database/schema/messages.js';
import { blockedUsers, friendships } from '../database/schema/friends.js';
import { reportEvidence } from '../database/schema/reports.js';
import { profiles, users } from '../database/schema/users.js';
import type { IKmsProvider } from '@chatible/shared';
import { createConfiguredKms } from '../kms/cloud-kms.service.js';
import { config } from '../config/env.js';
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

export type MediaType = 'IMAGE' | 'AUDIO' | 'VIDEO';
export type MediaStatus = 'PENDING_UPLOAD' | 'READY' | 'FAILED';

export interface MediaAssetRow {
  id: string;
  sessionId: string;
  ownerId: string;
  recipientId: string;
  objectKey: string;
  mediaType: string;
  contentType: string;
  fileSize: number;
  encryptedDek: string;
  iv: string;
  authTag: string;
  status: string;
  verifiedMime: string | null;
  finalizedAt: Date | null;
  isAdult: boolean;
  senderConfirmed18Plus: boolean;
  senderConfirmedConsent: boolean;
  watermarkToken: string;
  createdAt?: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface MediaConsentRow {
  sessionId: string;
  recipientId: string;
  enabled: boolean;
}

export interface AdultConsentRow {
  sessionId: string;
  recipientId: string;
  enabled: boolean;
  policyAcknowledgedAt: Date | null;
}

export interface MediaTokenRow {
  mediaId: string;
  recipientId: string;
  tokenHash: string;
  traceCode?: string | null;
  watermarkText?: string | null;
  streamKeyWrapped?: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface SessionRow {
  id: string;
  sessionType?: string;
  userAId: string;
  userBId: string;
  expiresAt: Date;
  status: string;
}

export interface MediaWatermarkedVariantRow {
  id: string;
  mediaId: string;
  recipientId: string;
  objectKey: string;
  encryptedDek: string;
  iv: string;
  authTag: string;
  contentType: string;
  fileSize: number;
  traceCode: string;
  watermarkText: string;
  status: string;
  error?: string | null;
  updatedAt?: Date;
  expiresAt: Date;
}

export interface MediaObjectStore {
  presignPut(input: { key: string; contentType: string; contentLength: number; mediaId: string }): Promise<string>;
  putStream?(input: { key: string; body: NodeJS.ReadableStream | Buffer; contentType: string; contentLength: number }): Promise<void>;
  exists(key: string): Promise<boolean>;
  head?(key: string): Promise<{ exists: boolean; contentLength?: number; contentType?: string }>;
  get(key: string): Promise<{ body: unknown; contentType?: string; contentLength?: number }>;
  delete(key: string): Promise<void>;
}

export interface MediaRepository {
  getSession(id: string): Promise<SessionRow | null>;
  getAsset(id: string): Promise<MediaAssetRow | null>;
  insertAsset(asset: MediaAssetRow): Promise<void>;
  updateAssetStatus?(
    id: string,
    patch: { status: MediaStatus; fileSize?: number; verifiedMime?: string; finalizedAt?: Date }
  ): Promise<void>;
  listExpiredAssets(now: Date): Promise<Array<{ id: string; sessionId: string; objectKey: string }>>;
  deleteAsset(id: string): Promise<void>;
  getConsent(sessionId: string, recipientId: string): Promise<MediaConsentRow | null>;
  upsertConsent(sessionId: string, recipientId: string, enabled: boolean): Promise<void>;
  getAdultConsent?(sessionId: string, recipientId: string): Promise<AdultConsentRow | null>;
  upsertAdultConsent?(sessionId: string, recipientId: string, enabled: boolean, policyAcknowledged: boolean): Promise<void>;
  areFriends?(userAId: string, userBId: string): Promise<boolean>;
  isBlocked?(userAId: string, userBId: string): Promise<boolean>;
  getSafeRecipientLabel?(userId: string): Promise<string>;
  insertToken(token: MediaTokenRow): Promise<void>;
  getToken(tokenHash: string): Promise<MediaTokenRow | null>;
  revokeAsset(mediaId: string, at: Date): Promise<void>;
  isEvidence(mediaId: string): Promise<boolean>;
  getUserStatus?(userId: string): Promise<string | null>;
  getWatermarkedVariant?(mediaId: string, recipientId: string): Promise<MediaWatermarkedVariantRow | null>;
  upsertWatermarkedVariant?(variant: Omit<MediaWatermarkedVariantRow, 'id'>): Promise<void>;
  listWatermarkedVariantsForMedia?(mediaId: string): Promise<Array<{ objectKey: string }>>;
}

export class MediaError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

export class MediaProcessingPendingError extends Error {
  constructor(
    public readonly retryAfterMs: number,
    message: string
  ) {
    super(message);
  }
}

const MEDIA_SIZE_LIMIT_BYTES: Record<MediaType, number> = {
  IMAGE: 30_000_000,
  VIDEO: 100_000_000,
  AUDIO: 20_000_000,
};

const MEDIA_SIZE_LABEL: Record<MediaType, string> = {
  IMAGE: 'Ảnh phải nhỏ hơn 30 MB.',
  VIDEO: 'Video phải nhỏ hơn 100 MB.',
  AUDIO: 'Ghi âm phải nhỏ hơn 20 MB.',
};

const CONTENT_TYPE_PREFIX: Record<MediaType, string> = {
  IMAGE: 'image/',
  AUDIO: 'audio/',
  VIDEO: 'video/',
};

const ORPHAN_UPLOAD_TTL_MS = 20 * 60 * 1000;

const defaultRepository: MediaRepository = {
  async getSession(id) {
    const rows = await db
      .select({
        id: chatSessions.id,
        sessionType: chatSessions.sessionType,
        userAId: chatSessions.userAId,
        userBId: chatSessions.userBId,
        expiresAt: chatSessions.expiresAt,
        status: chatSessions.status,
      })
      .from(chatSessions)
      .where(eq(chatSessions.id, id))
      .limit(1);
    return rows[0] ?? null;
  },
  async getAsset(id) {
    const rows = await db.select().from(mediaAssets).where(eq(mediaAssets.id, id)).limit(1);
    if (!rows[0]) return null;
    return {
      ...rows[0],
      verifiedMime: rows[0].verifiedMime ?? null,
      finalizedAt: rows[0].finalizedAt ?? null,
      revokedAt: rows[0].revokedAt ?? null,
    };
  },
  async listExpiredAssets(now) {
    const stalePendingThreshold = new Date(now.getTime() - ORPHAN_UPLOAD_TTL_MS);
    return db
      .select({ id: mediaAssets.id, sessionId: mediaAssets.sessionId, objectKey: mediaAssets.objectKey })
      .from(mediaAssets)
      .where(
        or(
          isNotNull(mediaAssets.revokedAt),
          lte(mediaAssets.expiresAt, now),
          eq(mediaAssets.status, 'FAILED'),
          and(eq(mediaAssets.status, 'PENDING_UPLOAD'), lt(mediaAssets.createdAt, stalePendingThreshold))
        )
      );
  },
  async deleteAsset(id) {
    await db.delete(mediaAssets).where(eq(mediaAssets.id, id));
  },
  async insertAsset(asset) {
    await db.insert(mediaAssets).values({
      id: asset.id,
      sessionId: asset.sessionId,
      ownerId: asset.ownerId,
      recipientId: asset.recipientId,
      objectKey: asset.objectKey,
      mediaType: asset.mediaType,
      contentType: asset.contentType,
      fileSize: asset.fileSize,
      encryptedDek: asset.encryptedDek,
      iv: asset.iv,
      authTag: asset.authTag,
      status: asset.status,
      verifiedMime: asset.verifiedMime,
      finalizedAt: asset.finalizedAt,
      isAdult: asset.isAdult,
      senderConfirmed18Plus: asset.senderConfirmed18Plus,
      senderConfirmedConsent: asset.senderConfirmedConsent,
      watermarkToken: asset.watermarkToken,
      expiresAt: asset.expiresAt,
      revokedAt: asset.revokedAt,
    });
  },
  async updateAssetStatus(id, patch) {
    await db
      .update(mediaAssets)
      .set({
        status: patch.status,
        ...(patch.fileSize !== undefined ? { fileSize: patch.fileSize } : {}),
        ...(patch.verifiedMime !== undefined ? { verifiedMime: patch.verifiedMime } : {}),
        ...(patch.finalizedAt !== undefined ? { finalizedAt: patch.finalizedAt } : {}),
      })
      .where(eq(mediaAssets.id, id));
  },
  async getConsent(sessionId, recipientId) {
    const rows = await db
      .select({ sessionId: mediaConsents.sessionId, recipientId: mediaConsents.recipientId, enabled: mediaConsents.enabled })
      .from(mediaConsents)
      .where(and(eq(mediaConsents.sessionId, sessionId), eq(mediaConsents.recipientId, recipientId)))
      .limit(1);
    return rows[0] ?? null;
  },
  async upsertConsent(sessionId, recipientId, enabled) {
    const now = new Date();
    await db
      .insert(mediaConsents)
      .values({ sessionId, recipientId, enabled, grantedAt: enabled ? now : null, revokedAt: enabled ? null : now, updatedAt: now })
      .onConflictDoUpdate({
        target: [mediaConsents.sessionId, mediaConsents.recipientId],
        set: { enabled, grantedAt: enabled ? now : null, revokedAt: enabled ? null : now, updatedAt: now },
      });
  },
  async getAdultConsent(sessionId, recipientId) {
    const rows = await db
      .select({
        sessionId: adultConsents.sessionId,
        recipientId: adultConsents.recipientId,
        enabled: adultConsents.enabled,
        policyAcknowledgedAt: adultConsents.policyAcknowledgedAt,
      })
      .from(adultConsents)
      .where(and(eq(adultConsents.sessionId, sessionId), eq(adultConsents.recipientId, recipientId)))
      .limit(1);
    return rows[0] ?? null;
  },
  async upsertAdultConsent(sessionId, recipientId, enabled, policyAcknowledged) {
    const now = new Date();
    await db
      .insert(adultConsents)
      .values({
        sessionId,
        recipientId,
        enabled,
        policyAcknowledgedAt: policyAcknowledged ? now : null,
        grantedAt: enabled ? now : null,
        revokedAt: enabled ? null : now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [adultConsents.sessionId, adultConsents.recipientId],
        set: {
          enabled,
          ...(policyAcknowledged ? { policyAcknowledgedAt: now } : {}),
          grantedAt: enabled ? now : null,
          revokedAt: enabled ? null : now,
          updatedAt: now,
        },
      });
  },
  async areFriends(userAId, userBId) {
    const [row] = await db
      .select({ id: friendships.id })
      .from(friendships)
      .where(
        or(
          and(eq(friendships.user1Id, userAId), eq(friendships.user2Id, userBId)),
          and(eq(friendships.user1Id, userBId), eq(friendships.user2Id, userAId))
        )
      )
      .limit(1);
    return Boolean(row);
  },
  async isBlocked(userAId, userBId) {
    const [row] = await db
      .select({ id: blockedUsers.id })
      .from(blockedUsers)
      .where(
        or(
          and(eq(blockedUsers.blockerId, userAId), eq(blockedUsers.blockedId, userBId)),
          and(eq(blockedUsers.blockerId, userBId), eq(blockedUsers.blockedId, userAId))
        )
      )
      .limit(1);
    return Boolean(row);
  },
  async getSafeRecipientLabel(userId) {
    const [prof] = await db
      .select({ nickname: profiles.nickname })
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .limit(1);
    const cleaned = (prof?.nickname || 'Thành viên').replace(/[\r\n<>]/g, '').trim();
    return cleaned.slice(0, 20) || 'Thành viên';
  },
  async insertToken(token) {
    await db.insert(mediaViewTokens).values({
      mediaId: token.mediaId,
      recipientId: token.recipientId,
      tokenHash: token.tokenHash,
      traceCode: token.traceCode ?? null,
      watermarkText: token.watermarkText ?? null,
      streamKeyWrapped: token.streamKeyWrapped ?? null,
      expiresAt: token.expiresAt,
      revokedAt: token.revokedAt,
    });
  },
  async getToken(tokenHash) {
    const rows = await db
      .select({
        mediaId: mediaViewTokens.mediaId,
        recipientId: mediaViewTokens.recipientId,
        tokenHash: mediaViewTokens.tokenHash,
        traceCode: mediaViewTokens.traceCode,
        watermarkText: mediaViewTokens.watermarkText,
        streamKeyWrapped: mediaViewTokens.streamKeyWrapped,
        expiresAt: mediaViewTokens.expiresAt,
        revokedAt: mediaViewTokens.revokedAt,
      })
      .from(mediaViewTokens)
      .where(eq(mediaViewTokens.tokenHash, tokenHash))
      .limit(1);
    return rows[0] ? { ...rows[0], revokedAt: rows[0].revokedAt ?? null } : null;
  },
  async revokeAsset(mediaId, at) {
    await db.update(mediaAssets).set({ revokedAt: at }).where(eq(mediaAssets.id, mediaId));
    await db.update(mediaViewTokens).set({ revokedAt: at }).where(eq(mediaViewTokens.mediaId, mediaId));
  },
  async isEvidence(mediaId) {
    const [direct] = await db
      .select({ id: reportEvidence.id })
      .from(reportEvidence)
      .where(eq(reportEvidence.messageId, mediaId))
      .limit(1);
    if (direct) return true;

    const [viaMessage] = await db
      .select({ id: reportEvidence.id })
      .from(reportEvidence)
      .innerJoin(messages, eq(reportEvidence.messageId, messages.id))
      .where(
        or(
          sql`${messages.metadata}->>'mediaId' = ${mediaId}`,
          sql`${messages.metadata}->>'media_id' = ${mediaId}`
        )
      )
      .limit(1);
    return Boolean(viaMessage);
  },
  async getUserStatus(userId: string) {
    const [user] = await db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return user?.status ?? null;
  },
  async getWatermarkedVariant(mediaId: string, recipientId: string) {
    const [row] = await db
      .select()
      .from(mediaWatermarkedVariants)
      .where(and(eq(mediaWatermarkedVariants.mediaId, mediaId), eq(mediaWatermarkedVariants.recipientId, recipientId)))
      .limit(1);
    return row ?? null;
  },
  async upsertWatermarkedVariant(variant) {
    const now = new Date();
    await db
      .insert(mediaWatermarkedVariants)
      .values({
        mediaId: variant.mediaId,
        recipientId: variant.recipientId,
        objectKey: variant.objectKey,
        encryptedDek: variant.encryptedDek,
        iv: variant.iv,
        authTag: variant.authTag,
        contentType: variant.contentType,
        fileSize: variant.fileSize,
        traceCode: variant.traceCode,
        watermarkText: variant.watermarkText,
        status: variant.status,
        error: variant.error ?? null,
        expiresAt: variant.expiresAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [mediaWatermarkedVariants.mediaId, mediaWatermarkedVariants.recipientId],
        set: {
          objectKey: variant.objectKey,
          encryptedDek: variant.encryptedDek,
          iv: variant.iv,
          authTag: variant.authTag,
          contentType: variant.contentType,
          fileSize: variant.fileSize,
          traceCode: variant.traceCode,
          watermarkText: variant.watermarkText,
          status: variant.status,
          error: variant.error ?? null,
          expiresAt: variant.expiresAt,
          updatedAt: now,
        },
      });
  },
  async listWatermarkedVariantsForMedia(mediaId: string) {
    return db
      .select({ objectKey: mediaWatermarkedVariants.objectKey })
      .from(mediaWatermarkedVariants)
      .where(eq(mediaWatermarkedVariants.mediaId, mediaId));
  },
};

export function createDefaultMediaRepository(): MediaRepository {
  return defaultRepository;
}

class S3ObjectStore implements MediaObjectStore {
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

  constructor(options: MediaServiceOptions = {}) {
    this.repository = options.repository ?? defaultRepository;
    this.storage = options.storage ?? new S3ObjectStore();
    this.kms = options.kms ?? createConfiguredKms().kms;
    this.videoQueue = options.videoQueue;
    this.imageSemaphore = options.imageSemaphore ?? defaultImageSemaphore;
  }

  private async assertUserActive(userId: string): Promise<void> {
    if (this.repository.getUserStatus) {
      const status = await this.repository.getUserStatus(userId);
      if (status && (status === 'RESTRICTED' || status === 'DELETED')) {
        throw new MediaError(403, 'Tài khoản đã bị khóa hoặc đình chỉ do vi phạm chính sách cộng đồng.');
      }
    }
  }

  async hasMediaConsent(sessionId: string, recipientId: string): Promise<boolean> {
    return this.consentIsValid(sessionId, recipientId);
  }

  async hasAdultConsent(sessionId: string, recipientId: string): Promise<boolean> {
    return this.adultConsentIsValid(sessionId, recipientId);
  }

  private async sessionForParticipant(sessionId: string, userId: string): Promise<SessionRow> {
    const session = await this.repository.getSession(sessionId);
    if (!session || (session.userAId !== userId && session.userBId !== userId)) {
      throw new MediaError(403, 'Bạn không thuộc phiên trò chuyện này.');
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      throw new MediaError(410, 'Phiên trò chuyện đã hết hạn.');
    }
    return session;
  }

  private otherParticipant(session: SessionRow, userId: string): string {
    if (session.userAId === userId) return session.userBId;
    if (session.userBId === userId) return session.userAId;
    throw new MediaError(403, 'Bạn không thuộc phiên trò chuyện này.');
  }

  private async assertNotBlocked(userAId: string, userBId: string): Promise<void> {
    if (this.repository.isBlocked && (await this.repository.isBlocked(userAId, userBId))) {
      throw new MediaError(403, 'Không thể gửi hoặc xem media vì tồn tại trạng thái chặn giữa hai tài khoản.');
    }
  }

  private async consentIsValid(sessionId: string, recipientId: string, session?: SessionRow): Promise<boolean> {
    const targetSession = session ?? (await this.repository.getSession(sessionId));
    if (!targetSession) return false;
    if (targetSession.sessionType === 'FRIEND') {
      const other = targetSession.userAId === recipientId ? targetSession.userBId : targetSession.userAId;
      if (this.repository.isBlocked && (await this.repository.isBlocked(recipientId, other))) return false;
      if (this.repository.areFriends) {
        return this.repository.areFriends(recipientId, other);
      }
      return true;
    }
    const consent = await this.repository.getConsent(sessionId, recipientId);
    return consent?.enabled === true;
  }

  private async adultConsentIsValid(sessionId: string, recipientId: string): Promise<boolean> {
    if (!this.repository.getAdultConsent) return false;
    const consent = await this.repository.getAdultConsent(sessionId, recipientId);
    return consent?.enabled === true;
  }

  async setConsent(userId: string, sessionId: string, enabled: boolean, requestedRecipientId?: string): Promise<void> {
    await this.assertUserActive(userId);
    const session = await this.sessionForParticipant(sessionId, userId);
    if (requestedRecipientId && requestedRecipientId !== userId) {
      throw new MediaError(403, 'Chỉ người nhận mới có thể thay đổi quyền nhận media.');
    }
    this.otherParticipant(session, userId);
    await this.repository.upsertConsent(sessionId, userId, enabled);
  }

  async setAdultConsent(
    userId: string,
    sessionId: string,
    enabled: boolean,
    policyAcknowledged = false,
    requestedRecipientId?: string
  ): Promise<void> {
    await this.assertUserActive(userId);
    const session = await this.sessionForParticipant(sessionId, userId);
    if (requestedRecipientId && requestedRecipientId !== userId) {
      throw new MediaError(403, 'Chỉ người nhận mới có thể thay đổi quyền nhận nội dung nhạy cảm.');
    }
    this.otherParticipant(session, userId);
    if (enabled && !policyAcknowledged) {
      throw new MediaError(
        400,
        'Bạn cần xác nhận đã hiểu chính sách nội dung 18+ và giới hạn không thể chống chụp màn hình trước khi bật.'
      );
    }
    if (!this.repository.upsertAdultConsent) {
      throw new MediaError(501, 'Kho lưu trữ chưa hỗ trợ cấu hình đồng thuận nội dung nhạy cảm.');
    }
    await this.repository.upsertAdultConsent(sessionId, userId, enabled, policyAcknowledged);
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
    await this.assertUserActive(userId);
    const session = await this.sessionForParticipant(sessionId, userId);
    const partnerId = this.otherParticipant(session, userId);
    const [myMediaConsent, partnerMediaConsent, myAdultConsent, partnerAdultConsent] = await Promise.all([
      this.consentIsValid(sessionId, userId, session),
      this.consentIsValid(sessionId, partnerId, session),
      this.adultConsentIsValid(sessionId, userId),
      this.adultConsentIsValid(sessionId, partnerId),
    ]);
    return { myMediaConsent, partnerMediaConsent, myAdultConsent, partnerAdultConsent };
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
    await this.assertUserActive(userId);
    const session = await this.sessionForParticipant(input.sessionId, userId);
    if (session.sessionType === 'RANDOM' && session.status !== 'ACTIVE') {
      throw new MediaError(409, 'Phiên chat ngẫu nhiên đã kết thúc.');
    }
    if (input.recipientId === userId || input.recipientId !== this.otherParticipant(session, userId)) {
      throw new MediaError(403, 'Người nhận không thuộc phiên trò chuyện này.');
    }
    await this.assertNotBlocked(userId, input.recipientId);

    if (!(await this.consentIsValid(input.sessionId, input.recipientId, session))) {
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
      if (!(await this.adultConsentIsValid(input.sessionId, input.recipientId))) {
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
    await this.assertUserActive(userId);
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

    const session = await this.sessionForParticipant(asset.sessionId, userId);
    if (session.sessionType === 'RANDOM' && session.status !== 'ACTIVE') {
      return this.failAndDeleteUpload(asset, new MediaError(409, 'Phiên chat đã kết thúc trong lúc tải media.'));
    }
    await this.assertNotBlocked(asset.ownerId, asset.recipientId);

    if (!(await this.consentIsValid(asset.sessionId, asset.recipientId, session))) {
      return this.failAndDeleteUpload(asset, new MediaError(403, 'Người nhận đã tắt quyền nhận media.'));
    }
    if (asset.isAdult && !(await this.adultConsentIsValid(asset.sessionId, asset.recipientId))) {
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
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.mediaId)) {
      throw new MediaError(400, 'Mã media không hợp lệ.');
    }
    const asset = await this.repository.getAsset(input.mediaId);
    if (!asset || asset.revokedAt || asset.expiresAt.getTime() <= Date.now()) {
      throw new MediaError(404, 'Media không tồn tại, đã thu hồi hoặc hết hạn.');
    }
    if (asset.status !== 'READY') {
      throw new MediaError(409, 'Media chưa hoàn tất xác thực tải lên.');
    }
    if (
      asset.sessionId !== input.sessionId ||
      asset.ownerId !== input.senderId ||
      asset.recipientId !== input.recipientId
    ) {
      throw new MediaError(403, 'Media không khớp người gửi, người nhận hoặc phiên trò chuyện.');
    }
    if (asset.mediaType !== input.mediaType) {
      throw new MediaError(400, 'Loại media tin nhắn không khớp với tệp đã tải lên.');
    }
    if (asset.isAdult !== input.isAdultContent) {
      throw new MediaError(400, 'Cờ nội dung người lớn (18+) không khớp với media đã xác thực.');
    }

    const session = await this.sessionForParticipant(input.sessionId, input.senderId);
    if (!(await this.consentIsValid(input.sessionId, input.recipientId, session))) {
      throw new MediaError(403, 'Người nhận đã tắt quyền nhận media.');
    }
    if (asset.isAdult) {
      if (!asset.senderConfirmed18Plus || !asset.senderConfirmedConsent) {
        throw new MediaError(403, 'Thiếu cam kết hợp pháp của người gửi cho nội dung 18+.');
      }
      if (!(await this.adultConsentIsValid(input.sessionId, input.recipientId))) {
        throw new MediaError(403, 'Người nhận đã tắt quyền nhận nội dung nhạy cảm (18+).');
      }
    }

    return asset;
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
    await this.assertUserActive(userId);
    const asset = await this.repository.getAsset(mediaId);
    if (!asset || asset.revokedAt || asset.expiresAt.getTime() <= Date.now()) {
      throw new MediaError(404, 'Media không tồn tại hoặc đã hết hạn.');
    }
    if (asset.status !== 'READY') {
      throw new MediaError(409, 'Media chưa sẵn sàng để xem.');
    }
    const session = await this.sessionForParticipant(asset.sessionId, userId);
    if (session.userAId !== asset.ownerId && session.userBId !== asset.ownerId) {
      throw new MediaError(403, 'Media không thuộc phiên hợp lệ.');
    }
    if (userId !== asset.ownerId && userId !== asset.recipientId) {
      throw new MediaError(403, 'Bạn không có quyền xem media này.');
    }
    await this.assertNotBlocked(asset.ownerId, asset.recipientId);

    if (!(await this.consentIsValid(asset.sessionId, asset.recipientId, session))) {
      throw new MediaError(403, 'Quyền nhận media đã bị thu hồi.');
    }
    if (asset.isAdult && !(await this.adultConsentIsValid(asset.sessionId, asset.recipientId))) {
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
    await this.assertUserActive(userId);
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
    const session = await this.sessionForParticipant(asset.sessionId, userId);
    if (session.userAId !== userId && session.userBId !== userId) {
      throw new MediaError(403, 'Bạn không thuộc phiên trò chuyện này.');
    }
    await this.assertNotBlocked(asset.ownerId, asset.recipientId);

    if (asset.revokedAt || asset.expiresAt.getTime() <= Date.now()) {
      throw new MediaError(403, 'Media đã bị thu hồi hoặc hết hạn.');
    }
    if (!(await this.consentIsValid(asset.sessionId, asset.recipientId, session))) {
      throw new MediaError(403, 'Quyền nhận media đã bị thu hồi.');
    }
    if (asset.isAdult && !(await this.adultConsentIsValid(asset.sessionId, asset.recipientId))) {
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

  async revoke(userId: string, mediaId: string): Promise<void> {
    await this.assertUserActive(userId);
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

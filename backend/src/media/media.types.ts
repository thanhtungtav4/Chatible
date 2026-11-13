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
  public readonly statusCode = 202;

  constructor(
    public readonly retryAfterMs: number,
    message: string
  ) {
    super(message);
  }
}

export const MEDIA_SIZE_LIMIT_BYTES: Record<MediaType, number> = {
  IMAGE: 30_000_000,
  VIDEO: 100_000_000,
  AUDIO: 20_000_000,
};

export const MEDIA_SIZE_LABEL: Record<MediaType, string> = {
  IMAGE: 'Ảnh phải nhỏ hơn 30 MB.',
  VIDEO: 'Video phải nhỏ hơn 100 MB.',
  AUDIO: 'Ghi âm phải nhỏ hơn 20 MB.',
};

export const CONTENT_TYPE_PREFIX: Record<MediaType, string> = {
  IMAGE: 'image/',
  AUDIO: 'audio/',
  VIDEO: 'video/',
};

export const ORPHAN_UPLOAD_TTL_MS = 20 * 60 * 1000;

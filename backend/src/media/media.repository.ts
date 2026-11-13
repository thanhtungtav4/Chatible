import { and, eq, isNotNull, lt, lte, or, sql } from 'drizzle-orm';
import { db } from '../database/index.js';
import { chatSessions } from '../database/schema/sessions.js';
import {
  adultConsents,
  mediaAssets,
  mediaConsents,
  mediaViewTokens,
  mediaWatermarkedVariants,
} from '../database/schema/media.js';
import { messages } from '../database/schema/messages.js';
import { blockedUsers, friendships } from '../database/schema/friends.js';
import { reportEvidence } from '../database/schema/reports.js';
import { profiles, users } from '../database/schema/users.js';
import { ORPHAN_UPLOAD_TTL_MS, type MediaRepository } from './media.types.js';

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

import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { eq, inArray, or } from 'drizzle-orm';
import { DataCleanupService } from './cleanup.service.js';
import { db } from '../database/index.js';
import { messages } from '../database/schema/messages.js';
import { reports, reportEvidence } from '../database/schema/reports.js';
import { chatSessions } from '../database/schema/sessions.js';
import { communityMessages, communityRooms } from '../database/schema/groups.js';
import { MediaService } from '../media/media.service.js';
import type { MediaObjectStore } from '../media/media.service.js';
import { mediaAssets } from '../database/schema/media.js';
import { users } from '../database/schema/users.js';

describe('Data cleanup retention', () => {
  it('preserves old open evidence until closure and purges closed reports after their retention deadline', async () => {
    const reporterId = randomUUID();
    const reportedUserId = randomUUID();
    const sessionId = randomUUID();
    const expiredMessageId = randomUUID();
    const openReportId = randomUUID();
    const oldReportId = randomUUID();
    const now = new Date();
    const expiredAt = new Date(now.getTime() - 60_000);
    await db.insert(users).values([
      { id: reporterId, email: `cleanup-${reporterId}@chatible.test` },
      { id: reportedUserId, email: `cleanup-${reportedUserId}@chatible.test` },
    ]);
    await db.insert(chatSessions).values({
      id: sessionId,
      sessionType: 'RANDOM',
      userAId: reporterId,
      userBId: reportedUserId,
      status: 'ENDED',
      expiresAt: expiredAt,
    });
    await db.insert(messages).values({
      id: expiredMessageId,
      sessionId,
      senderId: reportedUserId,
      messageType: 'TEXT',
      encryptedDek: 'wrapped-dek',
      ciphertext: 'ciphertext',
      iv: 'iv-value',
      authTag: 'auth-tag',
      expiresAt: expiredAt,
    });
    await db.insert(reports).values([
      {
        id: openReportId,
        sessionId,
        reporterId,
        reportedUserId,
        reason: 'HARASSMENT',
        status: 'OPEN',
        createdAt: expiredAt,
        expiresAt: null,
      },
      {
        id: oldReportId,
        sessionId: null,
        reporterId,
        reportedUserId,
        reason: 'SPAM',
        status: 'RESOLVED',
        closedAt: new Date(expiredAt.getTime() - 90 * 24 * 60 * 60 * 1000),
        expiresAt: expiredAt,
      },
    ]);
    await db.insert(reportEvidence).values([
      {
        reportId: openReportId,
        messageId: expiredMessageId,
        frozenEncryptedDek: 'frozen-wrapped-dek',
        frozenCiphertext: 'frozen-ciphertext',
        iv: 'frozen-iv',
        authTag: 'frozen-auth-tag',
      },
      {
        reportId: oldReportId,
        messageId: null,
        frozenEncryptedDek: 'expired-wrapped-dek',
        frozenCiphertext: 'expired-ciphertext',
        iv: 'expired-iv',
        authTag: 'expired-auth-tag',
      },
    ]);

    try {
      const result = await new DataCleanupService().executeCleanup(now);
      expect(result.executedAt).toBe(now.toISOString());
      expect(result.purgedMessagesCount).toBeGreaterThanOrEqual(1);
      expect(result.purgedRandomSessionsCount).toBeGreaterThanOrEqual(1);
      expect(result.purgedReportsCount).toBeGreaterThanOrEqual(1);

      expect(await db.select().from(messages).where(eq(messages.id, expiredMessageId))).toHaveLength(0);
      expect(await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId))).toHaveLength(0);
      const [survivingReport] = await db.select().from(reports).where(eq(reports.id, openReportId));
      expect(survivingReport?.status).toBe('OPEN');
      expect(survivingReport?.expiresAt).toBeNull();
      expect(survivingReport?.createdAt.getTime()).toBe(expiredAt.getTime());
      expect(survivingReport?.sessionId).toBeNull();
      const survivingEvidence = await db.select().from(reportEvidence).where(eq(reportEvidence.reportId, openReportId));
      expect(survivingEvidence).toHaveLength(1);
      expect(survivingEvidence[0]).toMatchObject({
        messageId: expiredMessageId,
        frozenEncryptedDek: 'frozen-wrapped-dek',
        frozenCiphertext: 'frozen-ciphertext',
        iv: 'frozen-iv',
        authTag: 'frozen-auth-tag',
      });
      expect(await db.select().from(reports).where(eq(reports.id, oldReportId))).toHaveLength(0);
      expect(await db.select().from(reportEvidence).where(eq(reportEvidence.reportId, oldReportId))).toHaveLength(0);
    } finally {
      await db.delete(reports).where(or(eq(reports.id, openReportId), eq(reports.id, oldReportId)));
      await db.delete(chatSessions).where(eq(chatSessions.id, sessionId));
      await db.delete(users).where(inArray(users.id, [reporterId, reportedUserId]));
    }
  });
  it('retains an expired session while its external media object deletion is pending', async () => {
    const userAId = randomUUID();
    const userBId = randomUUID();
    const sessionId = randomUUID();
    const now = new Date();
    const expiredAt = new Date(now.getTime() - 60_000);
    await db.insert(users).values([
      { id: userAId, email: `media-cleanup-${userAId}@chatible.test` },
      { id: userBId, email: `media-cleanup-${userBId}@chatible.test` },
    ]);
    await db.insert(chatSessions).values({
      id: sessionId,
      sessionType: 'RANDOM',
      userAId,
      userBId,
      status: 'ENDED',
      expiresAt: expiredAt,
    });

    try {
      const cleanup = new DataCleanupService({
        cleanupExpiredAssets: async () => ({ deletedCount: 0, failedCount: 1, failedSessionIds: [sessionId] }),
      });
      const result = await cleanup.executeCleanup(now);
      expect(result.purgedRandomSessionsCount).toBe(0);
      expect(result.failedMediaCount).toBe(1);
      expect(await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId))).toHaveLength(1);
    } finally {
      await db.delete(chatSessions).where(eq(chatSessions.id, sessionId));
      await db.delete(users).where(inArray(users.id, [userAId, userBId]));
    }
  });
  it('deletes expired storage objects before purging their session', async () => {
    const userAId = randomUUID();
    const userBId = randomUUID();
    const sessionId = randomUUID();
    const mediaId = randomUUID();
    const objectKey = `media/${sessionId}/${mediaId}/cleanup-smoke`;
    const now = new Date();
    const expiredAt = new Date(now.getTime() - 60_000);
    const deletedObjectKeys: string[] = [];
    let sessionExistedAtObjectDelete = false;
    await db.insert(users).values([
      { id: userAId, email: `media-cleanup-order-${userAId}@chatible.test` },
      { id: userBId, email: `media-cleanup-order-${userBId}@chatible.test` },
    ]);
    await db.insert(chatSessions).values({
      id: sessionId,
      sessionType: 'RANDOM',
      userAId,
      userBId,
      status: 'ENDED',
      expiresAt: expiredAt,
    });
    await db.insert(mediaAssets).values({
      id: mediaId,
      sessionId,
      ownerId: userAId,
      recipientId: userBId,
      objectKey,
      mediaType: 'IMAGE',
      contentType: 'image/webp',
      fileSize: 16,
      encryptedDek: 'wrapped-dek',
      iv: 'iv-value',
      authTag: 'auth-tag',
      watermarkToken: randomUUID(),
      expiresAt: expiredAt,
    });

    const storage: MediaObjectStore = {
      async presignPut() { return ''; },
      async exists() { return true; },
      async get() { return { body: '' }; },
      async delete(key) {
        deletedObjectKeys.push(key);
        const sessions = await db
          .select({ id: chatSessions.id })
          .from(chatSessions)
          .where(eq(chatSessions.id, sessionId));
        sessionExistedAtObjectDelete = sessions.length === 1;
      },
    };

    try {
      const cleanup = new DataCleanupService(new MediaService({ storage }));
      const result = await cleanup.executeCleanup(now);

      expect(deletedObjectKeys).toEqual([objectKey]);
      expect(sessionExistedAtObjectDelete).toBe(true);
      expect(result).toMatchObject({
        purgedMediaCount: 1,
        failedMediaCount: 0,
        purgedRandomSessionsCount: 1,
      });
      expect(await db.select().from(mediaAssets).where(eq(mediaAssets.id, mediaId))).toHaveLength(0);
      expect(await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId))).toHaveLength(0);
    } finally {
      await db.delete(mediaAssets).where(eq(mediaAssets.id, mediaId));
      await db.delete(chatSessions).where(eq(chatSessions.id, sessionId));
      await db.delete(users).where(inArray(users.id, [userAId, userBId]));
    }
  });

  it('purges expired FRIEND sessions and expired community messages while keeping active friend sessions', async () => {
    const userAId = randomUUID();
    const userBId = randomUUID();
    const expiredFriendSessionId = randomUUID();
    const activeFriendSessionId = randomUUID();
    const roomId = randomUUID();
    const expiredGroupMsgId = randomUUID();
    const now = new Date();
    const expiredAt = new Date(now.getTime() - 60_000);
    const futureAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    await db.insert(users).values([
      { id: userAId, email: `friend-cleanup-a-${userAId}@chatible.test` },
      { id: userBId, email: `friend-cleanup-b-${userBId}@chatible.test` },
    ]);
    await db.insert(chatSessions).values([
      {
        id: expiredFriendSessionId,
        sessionType: 'FRIEND',
        userAId,
        userBId,
        status: 'ACTIVE',
        expiresAt: expiredAt,
      },
      {
        id: activeFriendSessionId,
        sessionType: 'FRIEND',
        userAId,
        userBId,
        status: 'ACTIVE',
        expiresAt: futureAt,
      },
    ]);
    await db.insert(communityRooms).values({
      id: roomId,
      name: `Cleanup Room ${roomId.slice(0, 6)}`,
      type: 'PUBLIC',
      createdBy: userAId,
    });
    await db.insert(communityMessages).values({
      id: expiredGroupMsgId,
      roomId,
      senderId: userAId,
      messageType: 'TEXT',
      encryptedDek: 'wrapped-dek',
      ciphertext: 'ciphertext',
      iv: 'iv',
      authTag: 'tag',
      expiresAt: expiredAt,
    });

    try {
      const result = await new DataCleanupService().executeCleanup(now);
      expect(result.purgedFriendSessionsCount).toBeGreaterThanOrEqual(1);
      expect(await db.select().from(chatSessions).where(eq(chatSessions.id, expiredFriendSessionId))).toHaveLength(0);
      expect(await db.select().from(chatSessions).where(eq(chatSessions.id, activeFriendSessionId))).toHaveLength(1);
      expect(await db.select().from(communityMessages).where(eq(communityMessages.id, expiredGroupMsgId))).toHaveLength(0);
    } finally {
      await db.delete(communityMessages).where(eq(communityMessages.roomId, roomId));
      await db.delete(communityRooms).where(eq(communityRooms.id, roomId));
      await db.delete(chatSessions).where(inArray(chatSessions.id, [expiredFriendSessionId, activeFriendSessionId]));
      await db.delete(users).where(inArray(users.id, [userAId, userBId]));
    }
  });
});

import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, or } from 'drizzle-orm';
import { SafetyService } from './safety.service.js';
import { EnvelopeCryptoService } from '../crypto/envelope.service.js';
import { LocalKmsService } from '../kms/local-kms.service.js';
import { db } from '../database/index.js';
import { blockedUsers } from '../database/schema/friends.js';
import { messages } from '../database/schema/messages.js';
import { reports, reportEvidence, restrictionAppeals } from '../database/schema/reports.js';
import { chatSessions } from '../database/schema/sessions.js';
import { profiles, users } from '../database/schema/users.js';

const cryptoService = new EnvelopeCryptoService(
  new LocalKmsService('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
);

async function seedUsers(ids: string[]) {
  await db.insert(users).values(ids.map((id) => ({ id, email: `safety-${id}@chatible.test` })));
  await db.insert(profiles).values(ids.map((userId, index) => ({
    userId,
    nickname: `SafetyUser ${index + 1}`,
    gender: 'MALE',
    birthDate: '1995-05-05',
    calculatedAge: 29,
  })));
}

async function removeUsers(ids: string[]) {
  if (!ids.length) return;
  await db.delete(restrictionAppeals).where(inArray(restrictionAppeals.userId, ids));
  await db.delete(blockedUsers).where(or(...ids.flatMap((id) => [eq(blockedUsers.blockerId, id), eq(blockedUsers.blockedId, id)])));
  await db.delete(reports).where(or(...ids.flatMap((id) => [eq(reports.reporterId, id), eq(reports.reportedUserId, id)])));
  await db.delete(chatSessions).where(or(eq(chatSessions.userAId, ids[0]!), eq(chatSessions.userBId, ids[0]!)));
  await db.delete(chatSessions).where(or(...ids.slice(1).flatMap((id) => [eq(chatSessions.userAId, id), eq(chatSessions.userBId, id)])));
  await db.delete(profiles).where(inArray(profiles.userId, ids));
  await db.delete(users).where(inArray(users.id, ids));
}

describe('Persistent report evidence and blocking', () => {
  it('stores canonical encrypted evidence atomically and rejects evidence outside the session', async () => {
    const reporterId = randomUUID();
    const reportedUserId = randomUUID();
    const outsiderId = randomUUID();
    const sessionId = randomUUID();
    const messageId = randomUUID();
    const otherSessionId = randomUUID();
    const otherMessageId = randomUUID();
    const superAdminId = randomUUID();
    const service = new SafetyService(cryptoService, superAdminId);
    const encrypted = await cryptoService.encrypt('encrypted evidence source');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await seedUsers([reporterId, reportedUserId, outsiderId]);
    await db.insert(chatSessions).values({
      id: sessionId,
      userAId: reporterId,
      userBId: reportedUserId,
      status: 'ENDED',
      expiresAt,
    });
    await db.insert(chatSessions).values({
      id: otherSessionId,
      userAId: reporterId,
      userBId: reportedUserId,
      status: 'ENDED',
      expiresAt,
    });
    await db.insert(messages).values({
      id: messageId,
      sessionId,
      senderId: reportedUserId,
      messageType: 'TEXT',
      encryptedDek: encrypted.encryptedDek,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      expiresAt,
    });
    await db.insert(messages).values({
      id: otherMessageId,
      sessionId: otherSessionId,
      senderId: reportedUserId,
      messageType: 'TEXT',
      encryptedDek: encrypted.encryptedDek,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      expiresAt,
    });

    try {
      const created = await service.createReport({
        sessionId,
        reporterId,
        reportedUserId,
        reason: 'HARASSMENT',
        evidenceMessages: [{ messageId }],
      });
      const evidenceRows = await db.select().from(reportEvidence).where(eq(reportEvidence.reportId, created.reportId));
      expect(evidenceRows).toHaveLength(1);
      expect(evidenceRows[0]).toMatchObject({
        messageId,
        frozenEncryptedDek: encrypted.encryptedDek,
        frozenCiphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        messageType: 'TEXT',
      });
      expect(await service.isBlocked(reporterId, reportedUserId)).toBe(true);
      expect(await service.isBlocked(reportedUserId, reporterId)).toBe(true);
      expect(created.expiresAt).toBeNull();
      const [persistedReport] = await db.select().from(reports).where(eq(reports.id, created.reportId));
      expect(persistedReport?.expiresAt).toBeNull();
      const opened = await service.openReportForAdjudication(superAdminId, created.reportId);
      expect(opened.decryptedMessages).toEqual([{ messageId, plaintext: 'encrypted evidence source' }]);

      await expect(service.createReport({
        sessionId,
        reporterId,
        reportedUserId,
        reason: 'HARASSMENT',
        evidenceMessages: [{ messageId: randomUUID() }],
      })).rejects.toThrow('Không thể lưu báo cáo và bằng chứng vào cơ sở dữ liệu.');
      await expect(service.createReport({
        sessionId,
        reporterId,
        reportedUserId,
        reason: 'HARASSMENT',
        evidenceMessages: [{ messageId: otherMessageId }],
      })).rejects.toThrow('Không thể lưu báo cáo và bằng chứng vào cơ sở dữ liệu.');
      await expect(service.createReport({
        sessionId,
        reporterId,
        reportedUserId,
        reason: 'HARASSMENT',
        evidenceMessages: [{ messageId }, { messageId }],
      })).rejects.toThrow('Không thể lưu báo cáo và bằng chứng vào cơ sở dữ liệu.');
      await expect(service.createReport({
        sessionId,
        reporterId: outsiderId,
        reportedUserId,
        reason: 'HARASSMENT',
        evidenceMessages: [],
      })).rejects.toThrow('Không thể lưu báo cáo và bằng chứng vào cơ sở dữ liệu.');
      const storedReports = await db.select().from(reports).where(eq(reports.reporterId, reporterId));
      expect(storedReports).toHaveLength(1);
      expect(await db.select().from(reportEvidence).where(eq(reportEvidence.reportId, storedReports[0]!.id))).toHaveLength(1);
    } finally {
      await removeUsers([reporterId, reportedUserId, outsiderId]);
    }
  });

  it('persists a block before exposing the two-way block state', async () => {
    const blockerId = randomUUID();
    const blockedId = randomUUID();
    const service = new SafetyService(cryptoService);
    await seedUsers([blockerId, blockedId]);

    try {
      await expect(service.blockUser(blockerId, blockerId)).rejects.toThrow('Không thể tự chặn chính mình.');
      await service.blockUser(blockerId, blockedId);
      const rows = await db.select().from(blockedUsers).where(
        and(eq(blockedUsers.blockerId, blockerId), eq(blockedUsers.blockedId, blockedId))
      );
      expect(rows).toHaveLength(1);
      expect(await service.isBlocked(blockerId, blockedId)).toBe(true);
      expect(await service.isBlocked(blockedId, blockerId)).toBe(true);
    } finally {
      await removeUsers([blockerId, blockedId]);
    }
  });

  it('supports unblocking and listing blocked users', async () => {
    const blockerId = randomUUID();
    const blockedId = randomUUID();
    const service = new SafetyService(cryptoService);
    await seedUsers([blockerId, blockedId]);

    try {
      await service.blockUser(blockerId, blockedId);
      const list = await service.listBlockedUsers(blockerId);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        userId: blockedId,
        nickname: 'SafetyUser 2',
      });

      const unblockRes = await service.unblockUser(blockerId, blockedId);
      expect(unblockRes).toEqual({ status: 'UNBLOCKED' });
      expect(await service.isBlocked(blockerId, blockedId)).toBe(false);
      const emptyList = await service.listBlockedUsers(blockerId);
      expect(emptyList).toHaveLength(0);
    } finally {
      await removeUsers([blockerId, blockedId]);
    }
  });

  it('submits restriction appeals and rejects duplicate pending appeals', async () => {
    const userId = randomUUID();
    const service = new SafetyService(cryptoService);
    await seedUsers([userId]);

    try {
      await expect(service.createAppeal(userId, 'short')).rejects.toThrow('Lý do khiếu nại phải có ít nhất 10 ký tự.');
      const appeal = await service.createAppeal(userId, 'Tôi muốn khiếu nại quyết định hạn chế tài khoản');
      expect(appeal).toMatchObject({
        userId,
        status: 'PENDING',
        reason: 'Tôi muốn khiếu nại quyết định hạn chế tài khoản',
      });
      await expect(service.createAppeal(userId, 'Gửi lại đơn khiếu nại lần 2')).rejects.toThrow('Bạn đã có đơn khiếu nại đang chờ xử lý.');
    } finally {
      await removeUsers([userId]);
    }
  });
});

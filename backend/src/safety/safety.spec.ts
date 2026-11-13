import fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, or } from 'drizzle-orm';
import { AdminService } from '../admin/admin.service.js';
import { JwtUtil } from '../auth/jwt.util.js';
import { CSRF_COOKIE_NAME, registerCsrfOriginProtection, SESSION_COOKIE_NAME } from '../auth/session-auth.util.js';
import { config } from '../config/env.js';
import { SafetyController } from './safety.controller.js';
import { SafetyNotificationService } from './notification.service.js';
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

  it('delivers IN_REVIEW transition and privacy-preserving safety notifications to reporter and restricted user across report & appeal lifecycle', async () => {
    const reporterId = randomUUID();
    const reportedId = randomUUID();
    const sessionId = randomUUID();
    const messageId = randomUUID();

    const safetyService = new SafetyService(cryptoService, config.superAdminId);
    const notificationService = new SafetyNotificationService();
    const adminService = new AdminService(cryptoService, config.superAdminId, undefined, undefined, notificationService);

    const app = fastify({ logger: false });
    await app.register(fastifyCookie);
    registerCsrfOriginProtection(app);
    new SafetyController(safetyService, notificationService).registerRoutes(app);
    await app.ready();

    try {
      const existingAdmin = await db.query.users.findFirst({ where: eq(users.id, config.superAdminId) });
      if (!existingAdmin) {
        await db.insert(users).values({
          id: config.superAdminId,
          email: `safety-admin-${randomUUID()}@chatible.test`,
          status: 'SYSTEM',
        });
      }

      await seedUsers([reporterId, reportedId]);
      await db.insert(chatSessions).values({
        id: sessionId,
        userAId: reporterId,
        userBId: reportedId,
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      const encrypted = await cryptoService.encrypt('Tin nhắn vi phạm để kiểm thử thông báo');
      await db.insert(messages).values({
        id: messageId,
        sessionId,
        senderId: reportedId,
        encryptedDek: encrypted.encryptedDek,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        ciphertext: encrypted.ciphertext,
        messageType: 'TEXT',
        expiresAt: new Date(Date.now() + 86_400_000),
      });

      const report = await safetyService.createReport({
        sessionId,
        reporterId,
        reportedUserId: reportedId,
        reason: 'HARASSMENT',
        description: 'Kiểm thử luồng thông báo báo cáo',
        evidenceMessages: [{ messageId }],
      });

      const inReview = await adminService.markReportInReview(report.reportId, config.superAdminId, '127.0.0.1');
      expect(inReview).toEqual({ status: 'IN_REVIEW', reportId: report.reportId });
      await expect(adminService.markReportInReview(report.reportId, config.superAdminId, '127.0.0.1')).rejects.toThrow();

      await adminService.resolveReport(report.reportId, config.superAdminId, '127.0.0.1', {
        conclusion: 'ACTION_TAKEN',
        adminNote: 'Đã xử lý hành vi quấy rối',
        restrictUser: true,
      });

      const reporterTok = JwtUtil.sign({ sub: reporterId, email: `safety-${reporterId}@chatible.test` }, config.jwtSecret);
      const reportedTok = JwtUtil.sign({ sub: reportedId, email: `safety-${reportedId}@chatible.test` }, config.jwtSecret);
      const csrf = 'safety-notif-csrf';
      const reporterCookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(reporterTok)}; ${CSRF_COOKIE_NAME}=${csrf}`;
      const reportedCookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(reportedTok)}; ${CSRF_COOKIE_NAME}=${csrf}`;

      // Reporter receives REPORT_RESOLVED notification and can mark read
      const repNotifsRes = await app.inject({
        method: 'GET',
        url: '/api/v1/notifications',
        headers: { cookie: reporterCookie },
      });
      expect(repNotifsRes.statusCode).toBe(200);
      expect(repNotifsRes.json().unreadCount).toBe(1);
      expect(repNotifsRes.json().notifications[0]).toMatchObject({
        type: 'REPORT_RESOLVED',
        isRead: false,
      });

      const readRes = await app.inject({
        method: 'POST',
        url: '/api/v1/notifications/read',
        headers: { cookie: reporterCookie, 'x-csrf-token': csrf },
        payload: {},
      });
      expect(readRes.statusCode).toBe(200);
      expect(readRes.json().unreadCount).toBe(0);

      // Restricted user still receives ACCOUNT_RESTRICTED notification without leaking reporter identity
      const accusedNotifsRes = await app.inject({
        method: 'GET',
        url: '/api/v1/notifications',
        headers: { cookie: reportedCookie },
      });
      expect(accusedNotifsRes.statusCode).toBe(200);
      expect(accusedNotifsRes.json().unreadCount).toBe(1);
      const restrictedNotif = accusedNotifsRes.json().notifications[0];
      expect(restrictedNotif.type).toBe('ACCOUNT_RESTRICTED');
      expect(restrictedNotif.body).not.toContain(reporterId);
      expect(restrictedNotif.body).not.toContain('SafetyUser 1');

      // Restricted user appeals -> Admin approves -> APPEAL_DECISION notification delivered & user restored ACTIVE
      const appealRes = await app.inject({
        method: 'POST',
        url: '/api/v1/appeals',
        headers: { cookie: reportedCookie, 'x-csrf-token': csrf },
        payload: { reason: 'Tôi cam kết tuân thủ quy tắc và mong được xem xét mở khóa' },
      });
      expect(appealRes.statusCode).toBe(201);
      const appealId = appealRes.json().id as string;

      await adminService.resolveAppeal(appealId, config.superAdminId, 'APPROVE', 'Chấp thuận mở khóa thử nghiệm');

      const afterAppealNotifs = await app.inject({
        method: 'GET',
        url: '/api/v1/notifications',
        headers: { cookie: reportedCookie },
      });
      expect(afterAppealNotifs.statusCode).toBe(200);
      expect(afterAppealNotifs.json().unreadCount).toBe(2);
      expect(afterAppealNotifs.json().notifications[0]).toMatchObject({
        type: 'APPEAL_DECISION',
      });
      expect(afterAppealNotifs.json().notifications[0].body).toContain('khôi phục');
    } finally {
      await app.close();
      await removeUsers([reporterId, reportedId]);
    }
  });
});

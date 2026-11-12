import { and, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import * as OTPAuth from 'otpauth';
import { db } from '../database/index.js';
import { users, profiles } from '../database/schema/users.js';
import { chatSessions } from '../database/schema/sessions.js';
import { messages } from '../database/schema/messages.js';
import { mediaAssets } from '../database/schema/media.js';
import { reports, reportEvidence, restrictionAppeals } from '../database/schema/reports.js';
import { communityMessages, communityRooms } from '../database/schema/groups.js';
import { auditLogs } from '../database/schema/audit.js';
import { systemSettings } from '../database/schema/settings.js';
import { EnvelopeCryptoService } from '../crypto/envelope.service.js';
import { config } from '../config/env.js';
import {
  decryptSettingSecret,
  encryptSettingSecret,
  MailService,
  SMTP_PASSWORD_MASK,
  SmtpConfigOverride,
} from '../mail/mail.service.js';
import { MediaService } from '../media/media.service.js';
import { AuditTrailService } from './audit.service.js';
import { tokenRevocationStore } from '../auth/session-auth.util.js';

export interface AdminStats {
  totalUsers: number;
  activeSessions: number;
  totalSessions: number;
  totalMessages: number;
  pendingReports: number;
  genderBreakdown: { male: number; female: number; other: number };
}

export interface ListSessionsOptions {
  page?: number;
  limit?: number;
  search?: string;
  type?: string;
  status?: string;
}

export class AdminService {
  private readonly auditService = new AuditTrailService();

  constructor(
    private readonly cryptoService: EnvelopeCryptoService,
    private readonly superAdminId: string = '00000000-0000-0000-0000-000000000001',
    private readonly mailService: MailService = new MailService({ cryptoService }),
    private readonly mediaService: MediaService = new MediaService()
  ) {}

  private extractMediaIdFromMessage(content: string, metadata: unknown): string | null {
    if (metadata && typeof metadata === 'object') {
      const m = metadata as { mediaId?: string; media_id?: string };
      const id = m.mediaId || m.media_id;
      if (typeof id === 'string' && id.trim()) return id.trim();
    }
    try {
      const parsed = JSON.parse(content) as { mediaId?: string; media_id?: string };
      if (parsed && typeof parsed === 'object') {
        const id = parsed.mediaId || parsed.media_id;
        if (typeof id === 'string' && id.trim()) return id.trim();
      }
    } catch {
      // plain text
    }
    return null;
  }

  private async loadMediaMap(mediaIds: string[]) {
    const unique = [...new Set(mediaIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id)))];
    if (unique.length === 0) return new Map<string, { id: string; mediaType: string; isAdult: boolean; status: string; revokedAt: Date | null }>();
    const rows = await db
      .select({
        id: mediaAssets.id,
        mediaType: mediaAssets.mediaType,
        isAdult: mediaAssets.isAdult,
        status: mediaAssets.status,
        revokedAt: mediaAssets.revokedAt,
      })
      .from(mediaAssets)
      .where(inArray(mediaAssets.id, unique));
    return new Map(rows.map((r) => [r.id, r]));
  }

  /**
   * S11: Thống kê tổng quan thời gian thực
   */
  async getStats(): Promise<AdminStats> {
    const [userCount] = await db.select({ count: sql<number>`count(*)` }).from(users);
    const [sessionCount] = await db.select({ count: sql<number>`count(*)` }).from(chatSessions);
    const [activeCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(chatSessions)
      .where(eq(chatSessions.status, 'ACTIVE'));
    const [msgCount] = await db.select({ count: sql<number>`count(*)` }).from(messages);
    const [reportCount] = await db.select({ count: sql<number>`count(*)` }).from(reports).where(eq(reports.status, 'OPEN'));

    const allProfiles = await db.select({ gender: profiles.gender }).from(profiles);
    const genderBreakdown = {
      male: allProfiles.filter((profile) => profile.gender === 'MALE').length,
      female: allProfiles.filter((profile) => profile.gender === 'FEMALE').length,
      other: allProfiles.filter((profile) => profile.gender === 'OTHER').length,
    };

    return {
      totalUsers: Number(userCount?.count || 0),
      activeSessions: Number(activeCount?.count || 0),
      totalSessions: Number(sessionCount?.count || 0),
      totalMessages: Number(msgCount?.count || 0),
      pendingReports: Number(reportCount?.count || 0),
      genderBreakdown,
    };
  }

  async listReports() {
    return db.select().from(reports).orderBy(desc(reports.createdAt));
  }

  /**
   * S11: Super Admin mở bằng chứng báo cáo vi phạm (BẮT BUỘC ghi AuditLog hash-chain)
   */
  async adjudicateReport(reportId: string, actorId: string, ipAddress?: string) {
    if (actorId !== this.superAdminId) {
      throw new Error('Từ chối truy cập: Chỉ Quản trị viên Tối cao duy nhất mới có quyền xem bằng chứng.');
    }

    const [report] = await db.select().from(reports).where(eq(reports.id, reportId));
    if (!report) {
      throw new Error('Báo cáo không tồn tại hoặc đã hết hạn.');
    }

    await this.auditService.recordAudit({
      actorId,
      action: 'OPEN_REPORT_EVIDENCE',
      targetResourceId: report.id,
      ipAddress,
      details: { reason: report.reason, sessionId: report.sessionId },
    });

    const reporterUser = await db.query.users.findFirst({ where: eq(users.id, report.reporterId) });
    const reporterProfile = await db.query.profiles.findFirst({ where: eq(profiles.userId, report.reporterId) });
    const reportedUser = await db.query.users.findFirst({ where: eq(users.id, report.reportedUserId) });
    const reportedProfile = await db.query.profiles.findFirst({ where: eq(profiles.userId, report.reportedUserId) });

    const evidenceRows = await db
      .select({
        messageId: reportEvidence.messageId,
        groupMessageId: reportEvidence.groupMessageId,
        frozenAt: reportEvidence.frozenAt,
        frozenEncryptedDek: reportEvidence.frozenEncryptedDek,
        frozenCiphertext: reportEvidence.frozenCiphertext,
        iv: reportEvidence.iv,
        authTag: reportEvidence.authTag,
        messageType: reportEvidence.messageType,
      })
      .from(reportEvidence)
      .where(eq(reportEvidence.reportId, reportId));

    const mediaIdsCollector: string[] = [];

    const decryptedEvidence = await Promise.all(
      evidenceRows.map(async (row) => {
        let plaintext = '[Nội dung bằng chứng được bảo vệ]';
        try {
          if (row.iv && row.authTag) {
            plaintext = await this.cryptoService.decrypt({
              encryptedDek: row.frozenEncryptedDek,
              iv: row.iv,
              authTag: row.authTag,
              ciphertext: row.frozenCiphertext,
            });
          }
        } catch {
          plaintext = '[Không thể giải mã: Khóa đã thu hồi hoặc hết hạn]';
        }
        const mediaId = row.messageType !== 'TEXT' ? this.extractMediaIdFromMessage(plaintext, null) : null;
        if (mediaId) mediaIdsCollector.push(mediaId);
        return {
          messageId: row.messageId,
          groupMessageId: row.groupMessageId ?? null,
          frozenAt: row.frozenAt,
          messageType: row.messageType || 'TEXT',
          isAdult: false,
          metadata: mediaId ? { mediaId } : null,
          mediaId,
          content: plaintext,
        };
      })
    );

    let roomName: string | null = null;
    if (report.roomId) {
      const [roomRow] = await db
        .select({ name: communityRooms.name })
        .from(communityRooms)
        .where(eq(communityRooms.id, report.roomId))
        .limit(1);
      roomName = roomRow?.name ?? null;
    }

    const contextMsgs = report.sessionId
      ? await db
          .select()
          .from(messages)
          .where(eq(messages.sessionId, report.sessionId))
          .orderBy(messages.acceptedAt)
          .limit(50)
      : [];

    const decryptedContext = await Promise.all(
      contextMsgs.map(async (msg) => {
        let content: string;
        try {
          content = await this.cryptoService.decrypt({
            encryptedDek: msg.encryptedDek,
            iv: msg.iv,
            authTag: msg.authTag,
            ciphertext: msg.ciphertext,
          });
        } catch {
          content = '[Tin nhắn được bảo vệ]';
        }
        const mediaId = msg.messageType !== 'TEXT' ? this.extractMediaIdFromMessage(content, msg.metadata) : null;
        if (mediaId) mediaIdsCollector.push(mediaId);
        const isFromReporter = msg.senderId === report.reporterId;
        return {
          id: msg.id,
          senderId: msg.senderId,
          senderNickname: isFromReporter
            ? (reporterProfile?.nickname || 'Người tố cáo')
            : (reportedProfile?.nickname || 'Người bị tố cáo'),
          isReportedUser: msg.senderId === report.reportedUserId,
          messageType: msg.messageType,
          content,
          metadata: msg.metadata,
          mediaId,
          isAdult: msg.isAdultContent,
          sentAt: msg.acceptedAt,
        };
      })
    );

    const mediaMap = await this.loadMediaMap(mediaIdsCollector);

    return {
      report,
      roomName,
      reporter: {
        id: report.reporterId,
        nickname: reporterProfile?.nickname || 'Người ẩn danh',
        gender: reporterProfile?.gender || 'OTHER',
        age: reporterProfile?.calculatedAge || 20,
        email: reporterUser?.email || '',
      },
      reportedUser: {
        id: report.reportedUserId,
        nickname: reportedProfile?.nickname || 'Người ẩn danh',
        gender: reportedProfile?.gender || 'OTHER',
        age: reportedProfile?.calculatedAge || 20,
        status: reportedUser?.status || 'ACTIVE',
        email: reportedUser?.email || '',
      },
      evidence: decryptedEvidence.map((item) => ({
        ...item,
        mediaInfo: item.mediaId ? mediaMap.get(item.mediaId) ?? null : null,
      })),
      sessionContext: decryptedContext.map((item) => ({
        ...item,
        mediaInfo: item.mediaId ? mediaMap.get(item.mediaId) ?? null : null,
      })),
      auditLogged: true,
    };
  }

  /**
   * S11: Danh sách phiên chat hỗ trợ lọc & phân trang
   */
  async listSessions(options: ListSessionsOptions = {}) {
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 25));
    const offset = (page - 1) * limit;

    const conditions = [];
    if (options.type && ['RANDOM', 'FRIEND'].includes(options.type.toUpperCase())) {
      conditions.push(eq(chatSessions.sessionType, options.type.toUpperCase()));
    }
    if (options.status && ['ACTIVE', 'ENDED'].includes(options.status.toUpperCase())) {
      conditions.push(eq(chatSessions.status, options.status.toUpperCase()));
    }
    if (options.search && options.search.trim()) {
      const q = options.search.trim();
      const matchingUsers = await db
        .select({ userId: profiles.userId })
        .from(profiles)
        .where(ilike(profiles.nickname, `%${q}%`));
      const matchedIds = matchingUsers.map((u) => u.userId);
      const searchConds = [sql`${chatSessions.id}::text ILIKE ${`%${q}%`}`];
      if (matchedIds.length > 0) {
        searchConds.push(inArray(chatSessions.userAId, matchedIds), inArray(chatSessions.userBId, matchedIds));
      }
      conditions.push(or(...searchConds)!);
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const [countRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(chatSessions)
      .where(whereClause);
    const total = Number(countRow?.count || 0);

    const rows = await db
      .select()
      .from(chatSessions)
      .where(whereClause)
      .orderBy(desc(chatSessions.startedAt))
      .limit(limit)
      .offset(offset);

    const sessions = await Promise.all(
      rows.map(async (session) => {
        const profileA = await db.query.profiles.findFirst({ where: eq(profiles.userId, session.userAId) });
        const profileB = await db.query.profiles.findFirst({ where: eq(profiles.userId, session.userBId) });
        const [messageCount] = await db
          .select({ count: sql<number>`count(*)` })
          .from(messages)
          .where(eq(messages.sessionId, session.id));

        return {
          ...session,
          userANickname: profileA?.nickname || 'Người dùng A',
          userAGender: profileA?.gender || 'OTHER',
          userBNickname: profileB?.nickname || 'Người dùng B',
          userBGender: profileB?.gender || 'OTHER',
          messagesCount: Number(messageCount?.count || 0),
        };
      })
    );

    return {
      sessions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  /**
   * S11: Super Admin mở xem transcript phiên chat kèm metadata media (BẮT BUỘC ghi AuditLog)
   */
  async openSessionTranscript(sessionId: string, actorId: string, ipAddress?: string) {
    if (actorId !== this.superAdminId) {
      throw new Error('Từ chối truy cập: Chỉ Quản trị viên Tối cao mới có quyền tra cứu transcript.');
    }

    await this.auditService.recordAudit({
      actorId,
      action: 'OPEN_CHAT_TRANSCRIPT',
      targetResourceId: sessionId,
      ipAddress,
    });

    const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
    if (!session) {
      throw new Error('Phiên trò chuyện không tồn tại.');
    }
    const profA = await db.query.profiles.findFirst({ where: eq(profiles.userId, session.userAId) });
    const profB = await db.query.profiles.findFirst({ where: eq(profiles.userId, session.userBId) });

    const sessionMsgs = await db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(messages.acceptedAt);

    const mediaIds: string[] = [];
    const decryptedMessages = await Promise.all(
      sessionMsgs.map(async (msg) => {
        let plaintext: string;
        try {
          plaintext = await this.cryptoService.decrypt({
            encryptedDek: msg.encryptedDek,
            iv: msg.iv,
            authTag: msg.authTag,
            ciphertext: msg.ciphertext,
          });
        } catch {
          plaintext = '[Không thể giải mã: Khóa đã bị thu hồi hoặc hết hạn]';
        }
        const mediaId = msg.messageType !== 'TEXT' ? this.extractMediaIdFromMessage(plaintext, msg.metadata) : null;
        if (mediaId) mediaIds.push(mediaId);
        const isUserA = msg.senderId === session.userAId;
        return {
          id: msg.id,
          senderId: msg.senderId,
          senderNickname: isUserA ? (profA?.nickname || 'User A') : (profB?.nickname || 'User B'),
          isUserA,
          messageType: msg.messageType,
          content: plaintext,
          metadata: msg.metadata,
          mediaId,
          sentAt: msg.acceptedAt,
          isAdult: msg.isAdultContent,
        };
      })
    );

    const mediaMap = await this.loadMediaMap(mediaIds);

    return {
      sessionId,
      session,
      userA: { id: session.userAId, nickname: profA?.nickname || 'User A', gender: profA?.gender },
      userB: { id: session.userBId, nickname: profB?.nickname || 'User B', gender: profB?.gender },
      messages: decryptedMessages.map((m) => ({
        ...m,
        mediaInfo: m.mediaId ? mediaMap.get(m.mediaId) ?? null : null,
      })),
      auditLogged: true,
    };
  }

  async deleteGroupMessage(messageId: string, actorId: string, ipAddress?: string): Promise<{ deleted: boolean }> {
    if (actorId !== this.superAdminId) {
      throw new Error('Chỉ Super Admin mới có quyền gỡ tin nhắn nhóm.');
    }
    const now = new Date();
    const updated = await db
      .update(communityMessages)
      .set({ deletedAt: now, deletedBy: actorId })
      .where(and(eq(communityMessages.id, messageId), isNull(communityMessages.deletedAt)))
      .returning({ id: communityMessages.id, roomId: communityMessages.roomId });
    if (updated.length === 0) {
      throw new Error('Tin nhắn nhóm không tồn tại hoặc đã được gỡ trước đó.');
    }
    await this.auditService.recordAudit({
      actorId,
      action: 'DELETE_GROUP_MESSAGE',
      targetResourceId: messageId,
      ipAddress,
      details: { roomId: updated[0]!.roomId },
    });
    return { deleted: true };
  }

  /**
   * MOD-08 / D25: Giải mã nội dung media cho Super Admin (kể cả đã thu hồi), bắt buộc ghi AuditLog.
   */
  async openAdminMedia(mediaId: string, actorId: string, ipAddress?: string) {
    if (actorId !== this.superAdminId) {
      throw new Error('Từ chối truy cập: Chỉ Quản trị viên Tối cao mới có quyền mở xem media.');
    }

    const decrypted = await this.mediaService.decryptMediaForAdmin(mediaId);
    await this.auditService.recordAudit({
      actorId,
      action: 'OPEN_ADMIN_MEDIA',
      targetResourceId: mediaId,
      ipAddress,
      details: {
        sessionId: decrypted.sessionId,
        mediaType: decrypted.mediaType,
        isAdult: decrypted.isAdult,
        wasRevoked: Boolean(decrypted.revokedAt),
      },
    });

    return decrypted;
  }

  async listAuditLogs(limit = 100) {
    return db
      .select()
      .from(auditLogs)
      .orderBy(desc(auditLogs.seq), desc(auditLogs.timestamp))
      .limit(Math.min(500, Math.max(1, limit)));
  }

  async verifyAuditChain() {
    return this.auditService.verifyAuditChain();
  }

  async exportAuditLogs() {
    return this.auditService.exportImmutableSnapshot();
  }

  async resolveReport(
    reportId: string,
    actorId: string,
    ipAddress?: string,
    options?: {
      conclusion?: 'ACTION_TAKEN' | 'DISMISSED' | 'NO_VIOLATION';
      adminNote?: string;
      restrictUser?: boolean;
    }
  ) {
    if (actorId !== this.superAdminId) {
      throw new Error('Chỉ Super Admin mới có quyền đóng báo cáo.');
    }

    const res = await db.transaction(async (tx) => {
      const [report] = await tx
        .select({ status: reports.status, reportedUserId: reports.reportedUserId })
        .from(reports)
        .where(eq(reports.id, reportId))
        .limit(1);
      if (!report) throw new Error('Báo cáo không tồn tại.');
      if (report.status === 'RESOLVED' || report.status === 'DISMISSED') {
        throw new Error('Báo cáo đã được đóng.');
      }

      const closedAt = new Date();
      const expiresAt = new Date(closedAt.getTime() + 90 * 24 * 60 * 60 * 1000);
      const conclusion = options?.conclusion || 'ACTION_TAKEN';
      const [updatedReport] = await tx
        .update(reports)
        .set({
          status: 'RESOLVED',
          resolutionConclusion: conclusion,
          adminNote: options?.adminNote,
          resolvedBy: actorId,
          closedAt,
          expiresAt,
        })
        .where(eq(reports.id, reportId))
        .returning({ id: reports.id });
      if (!updatedReport) throw new Error('Báo cáo không tồn tại.');

      if (options?.restrictUser) {
        await tx
          .update(users)
          .set({ status: 'RESTRICTED', updatedAt: closedAt })
          .where(eq(users.id, report.reportedUserId));
      }

      await this.auditService.recordAudit(
        {
          actorId,
          action: 'RESOLVE_REPORT',
          targetResourceId: updatedReport.id,
          ipAddress,
          details: { conclusion, restrictUser: Boolean(options?.restrictUser) },
        },
        tx
      );
      return { status: 'RESOLVED', reportId: updatedReport.id, conclusion, reportedUserId: report.reportedUserId };
    });

    if (options?.restrictUser && res.reportedUserId) {
      await tokenRevocationStore.revokeUserTokensBefore(res.reportedUserId, Date.now());
    }
    return { status: res.status, reportId: res.reportId, conclusion: res.conclusion };
  }

  async listAppeals() {
    return db
      .select({
        id: restrictionAppeals.id,
        userId: restrictionAppeals.userId,
        reason: restrictionAppeals.reason,
        status: restrictionAppeals.status,
        createdAt: restrictionAppeals.createdAt,
        reviewedAt: restrictionAppeals.reviewedAt,
        adminNote: restrictionAppeals.adminNote,
        userEmail: users.email,
        nickname: profiles.nickname,
      })
      .from(restrictionAppeals)
      .innerJoin(users, eq(restrictionAppeals.userId, users.id))
      .leftJoin(profiles, eq(restrictionAppeals.userId, profiles.userId))
      .orderBy(desc(restrictionAppeals.createdAt));
  }

  async resolveAppeal(
    appealId: string,
    actorId: string,
    decision: 'APPROVE' | 'REJECT',
    adminNote?: string,
    ipAddress?: string
  ) {
    if (actorId !== this.superAdminId) {
      throw new Error('Chỉ Super Admin mới có quyền duyệt khiếu nại.');
    }

    return db.transaction(async (tx) => {
      const [appeal] = await tx
        .select()
        .from(restrictionAppeals)
        .where(eq(restrictionAppeals.id, appealId))
        .limit(1);
      if (!appeal) throw new Error('Đơn khiếu nại không tồn tại.');
      if (appeal.status !== 'PENDING') {
        throw new Error('Đơn khiếu nại này đã được xử lý trước đó.');
      }

      const status = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
      const now = new Date();

      await tx
        .update(restrictionAppeals)
        .set({
          status,
          reviewedAt: now,
          reviewedBy: actorId,
          adminNote: adminNote || (decision === 'APPROVE' ? 'Đã chấp thuận khiếu nại' : 'Từ chối khiếu nại'),
        })
        .where(eq(restrictionAppeals.id, appealId));

      if (decision === 'APPROVE') {
        await tx
          .update(users)
          .set({ status: 'ACTIVE', updatedAt: now })
          .where(eq(users.id, appeal.userId));
      }

      await this.auditService.recordAudit(
        {
          actorId,
          action: decision === 'APPROVE' ? 'APPROVE_APPEAL' : 'REJECT_APPEAL',
          targetResourceId: appeal.id,
          ipAddress,
        },
        tx
      );

      return { status, appealId: appeal.id, userId: appeal.userId };
    });
  }

  async restrictUser(userId: string, actorId: string, reason: string, ipAddress?: string) {
    if (actorId !== this.superAdminId) {
      throw new Error('Chỉ Super Admin mới có quyền đình chỉ tài khoản.');
    }

    const res = await db.transaction(async (tx) => {
      const [user] = await tx
        .update(users)
        .set({ status: 'RESTRICTED', updatedAt: new Date() })
        .where(eq(users.id, userId))
        .returning({ id: users.id });
      if (!user) throw new Error('Không tìm thấy tài khoản cần đình chỉ.');

      await this.auditService.recordAudit(
        {
          actorId,
          action: 'REVOKE_USER',
          targetResourceId: user.id,
          ipAddress,
          details: { reason },
        },
        tx
      );
      return { status: 'RESTRICTED', userId: user.id, reason };
    });

    await tokenRevocationStore.revokeUserTokensBefore(userId, Date.now());
    return res;
  }

  private inferSettingCategory(key: string): string {
    if (key.startsWith('mail.')) return 'MAIL';
    if (key.startsWith('auth.')) return 'AUTH';
    if (key.startsWith('retention.')) return 'RETENTION';
    if (key.startsWith('admin.')) return 'SECURITY';
    return 'GENERAL';
  }

  async getSettings() {
    const rows = await db
      .select({
        key: systemSettings.key,
        value: systemSettings.value,
        description: systemSettings.description,
        category: systemSettings.category,
        updatedAt: systemSettings.updatedAt,
      })
      .from(systemSettings)
      .orderBy(systemSettings.category, systemSettings.key);

    return rows.map((row) => ({
      ...row,
      value:
        (row.key === 'mail.smtp.password' || row.key === 'admin.mfa.totp_secret') && row.value
          ? SMTP_PASSWORD_MASK
          : row.value,
    }));
  }

  async updateSettings(
    actorId: string,
    updates: Record<string, string>,
    ipAddress?: string
  ): Promise<{ success: boolean; updatedCount: number }> {
    if (actorId !== this.superAdminId) {
      throw new Error('Chỉ Super Admin mới có quyền cập nhật cấu hình hệ thống.');
    }

    const preparedEntries: Array<{ key: string; value: string; category: string }> = [];
    for (const [key, rawValue] of Object.entries(updates)) {
      if (key === 'admin.mfa.totp_secret' || key === 'admin.mfa.enabled') {
        continue; // Must use dedicated MFA verification flow
      }
      const valueStr = String(rawValue ?? '');
      if (key === 'mail.smtp.password') {
        if (valueStr === SMTP_PASSWORD_MASK) {
          continue;
        }
        const encrypted = await encryptSettingSecret(valueStr, this.cryptoService);
        preparedEntries.push({ key, value: encrypted, category: 'MAIL' });
        continue;
      }

      if (key === 'mail.smtp.port' && valueStr.trim() !== '') {
        const portNum = Number.parseInt(valueStr.trim(), 10);
        if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
          throw new Error('Cổng SMTP không hợp lệ (phải nằm trong khoảng 1 - 65535).');
        }
      }

      preparedEntries.push({
        key,
        value: valueStr,
        category: this.inferSettingCategory(key),
      });
    }

    if (preparedEntries.length === 0) return { success: true, updatedCount: 0 };

    const now = new Date();
    await db.transaction(async (tx) => {
      for (const entry of preparedEntries) {
        await tx
          .insert(systemSettings)
          .values({
            key: entry.key,
            value: entry.value,
            category: entry.category,
            updatedBy: actorId,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: systemSettings.key,
            set: {
              value: entry.value,
              updatedBy: actorId,
              updatedAt: now,
            },
          });
      }

      await this.auditService.recordAudit(
        {
          actorId,
          action: 'UPDATE_SYSTEM_SETTINGS',
          targetResourceId: actorId,
          ipAddress,
          details: { updatedKeys: preparedEntries.map((e) => e.key) },
        },
        tx
      );
    });

    return { success: true, updatedCount: preparedEntries.length };
  }

  async sendTestEmail(
    actorId: string,
    toEmail: string,
    overrides?: SmtpConfigOverride,
    ipAddress?: string
  ): Promise<{ success: boolean; message: string }> {
    if (actorId !== this.superAdminId) {
      throw new Error('Chỉ Super Admin mới có quyền gửi email kiểm thử.');
    }

    const result = await this.mailService.sendTestEmail(toEmail, overrides);

    await this.auditService.recordAudit({
      actorId,
      action: 'TEST_SMTP_EMAIL',
      targetResourceId: actorId,
      ipAddress,
    });

    return result;
  }

  private async getStoredTotpSecret(): Promise<{ enabled: boolean; secretBase32: string }> {
    if (config.adminTotpSecret) {
      return { enabled: true, secretBase32: config.adminTotpSecret };
    }
    try {
      const rows = await db
        .select({ key: systemSettings.key, value: systemSettings.value })
        .from(systemSettings)
        .where(inArray(systemSettings.key, ['admin.mfa.enabled', 'admin.mfa.totp_secret']));
      const map = new Map(rows.map((r) => [r.key, r.value]));
      const enabled = map.get('admin.mfa.enabled') === 'true';
      const raw = map.get('admin.mfa.totp_secret') || '';
      if (!enabled || !raw) return { enabled: false, secretBase32: '' };
      const secretBase32 = await decryptSettingSecret(raw, this.cryptoService);
      return { enabled: Boolean(secretBase32), secretBase32 };
    } catch {
      return { enabled: false, secretBase32: '' };
    }
  }

  async getAdminMfaStatus(): Promise<{ enabled: boolean; source: 'env' | 'db' | 'none' }> {
    if (config.adminTotpSecret) return { enabled: true, source: 'env' };
    const stored = await this.getStoredTotpSecret();
    return { enabled: stored.enabled, source: stored.enabled ? 'db' : 'none' };
  }

  async verifyAdminTotp(totpCode?: string): Promise<boolean> {
    const { enabled, secretBase32 } = await this.getStoredTotpSecret();
    if (!enabled) return true;
    const code = (totpCode || '').trim();
    if (!/^\d{6}$/.test(code)) return false;

    const totp = new OTPAuth.TOTP({
      issuer: 'Chatible Admin',
      label: 'SuperAdmin',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secretBase32),
    });
    const delta = totp.validate({ token: code, window: 1 });
    return delta !== null;
  }

  generateAdminMfaSetup(actorId: string): { secretBase32: string; otpauthUri: string } {
    if (actorId !== this.superAdminId) {
      throw new Error('Chỉ Super Admin mới có quyền thiết lập MFA.');
    }
    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = new OTPAuth.TOTP({
      issuer: 'Chatible Admin',
      label: 'SuperAdmin',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret,
    });
    return { secretBase32: secret.base32, otpauthUri: totp.toString() };
  }

  async confirmEnableAdminMfa(
    actorId: string,
    secretBase32: string,
    code: string,
    ipAddress?: string
  ): Promise<{ enabled: boolean }> {
    if (actorId !== this.superAdminId) {
      throw new Error('Chỉ Super Admin mới có quyền kích hoạt MFA.');
    }
    const cleanCode = (code || '').trim();
    const totp = new OTPAuth.TOTP({
      issuer: 'Chatible Admin',
      label: 'SuperAdmin',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secretBase32.trim()),
    });
    if (totp.validate({ token: cleanCode, window: 1 }) === null) {
      throw new Error('Mã OTP 6 số không chính xác. Vui lòng thử lại.');
    }

    const encryptedSecret = await encryptSettingSecret(secretBase32.trim(), this.cryptoService);
    const now = new Date();
    await db.transaction(async (tx) => {
      for (const [key, value] of [
        ['admin.mfa.enabled', 'true'],
        ['admin.mfa.totp_secret', encryptedSecret],
      ] as const) {
        await tx
          .insert(systemSettings)
          .values({ key, value, category: 'SECURITY', updatedBy: actorId, updatedAt: now })
          .onConflictDoUpdate({
            target: systemSettings.key,
            set: { value, updatedBy: actorId, updatedAt: now },
          });
      }
      await this.auditService.recordAudit(
        { actorId, action: 'ENABLE_ADMIN_MFA', targetResourceId: actorId, ipAddress },
        tx
      );
    });

    return { enabled: true };
  }

  async disableAdminMfa(_actorId: string, _code: string, _ipAddress?: string): Promise<{ enabled: boolean }> {
    throw new Error('MFA Super Admin là bắt buộc và không thể tắt qua giao diện hoặc API.');
  }
}

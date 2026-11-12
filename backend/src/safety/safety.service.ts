import { EnvelopeCryptoService } from '../crypto/envelope.service.js';
import { db } from '../database/index.js';
import { reports, reportEvidence, restrictionAppeals } from '../database/schema/reports.js';
import { blockedUsers, friendRequests, friendships } from '../database/schema/friends.js';
import { chatSessions } from '../database/schema/sessions.js';
import { communityMembers, communityMessages, communityRooms } from '../database/schema/groups.js';
import { messages } from '../database/schema/messages.js';
import { profiles, users } from '../database/schema/users.js';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import crypto from 'node:crypto';
import { MessageType } from '@chatible/shared';

export type ReportReason =
  | 'UNDERAGE'
  | 'HARASSMENT'
  | 'NONCONSENSUAL_MEDIA'
  | 'THREAT'
  | 'SPAM'
  | 'OTHER';

export interface CreateReportDto {
  sessionId: string;
  reporterId: string;
  reportedUserId: string;
  reason: ReportReason;
  description?: string;
  evidenceMessages: Array<{ messageId: string }>;
}

export interface ReportRecord {
  id: string;
  sessionId: string;
  reporterId: string;
  reportedUserId: string;
  reason: ReportReason;
  description?: string;
  status: 'OPEN' | 'IN_REVIEW' | 'RESOLVED' | 'DISMISSED';
  createdAt: string;
  expiresAt: string | null;
  evidence: Array<{
    messageId: string;
    messageType: MessageType;
    frozenEncryptedDek: string;
    frozenCiphertext: string;
    iv: string;
    authTag: string;
  }>;
}

export interface AuditLogEntry {
  id: string;
  actorId: string;
  action: 'OPEN_REPORT_EVIDENCE' | 'REVOKE_USER' | 'RESOLVE_REPORT';
  targetResourceId: string;
  ipAddress?: string;
  timestamp: string;
}

type ReportInput = Omit<ReportRecord, 'evidence'> & { evidence: Array<{ messageId: string }> };
type ReportPersistence = (record: ReportInput) => Promise<ReportRecord>;

const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

type BlockPersistence = (blockerId: string, blockedId: string) => Promise<void>;

const persistBlock: BlockPersistence = async (blockerId, blockedId) => {
  if (!isUuid(blockerId) || !isUuid(blockedId)) {
    throw new Error('ID tài khoản không hợp lệ.');
  }
  await db.transaction(async (tx) => {
    await tx.insert(blockedUsers).values({ blockerId, blockedId }).onConflictDoNothing();
    await tx.delete(friendships).where(
      or(
        and(eq(friendships.user1Id, blockerId), eq(friendships.user2Id, blockedId)),
        and(eq(friendships.user1Id, blockedId), eq(friendships.user2Id, blockerId))
      )
    );
    await tx.delete(friendRequests).where(
      or(
        and(eq(friendRequests.fromUserId, blockerId), eq(friendRequests.toUserId, blockedId)),
        and(eq(friendRequests.fromUserId, blockedId), eq(friendRequests.toUserId, blockerId))
      )
    );
  });
};


const persistReport: ReportPersistence = async (record) => {
  if (
    !isUuid(record.sessionId) ||
    !isUuid(record.reporterId) ||
    !isUuid(record.reportedUserId) ||
    record.evidence.some((item) => !isUuid(item.messageId))
  ) {
    throw new Error('ID báo cáo hoặc bằng chứng không hợp lệ.');
  }

  return db.transaction(async (tx) => {
    const [session] = await tx
      .select({ userAId: chatSessions.userAId, userBId: chatSessions.userBId })
      .from(chatSessions)
      .where(eq(chatSessions.id, record.sessionId))
      .limit(1);
    if (!session) {
      throw new Error('Không tìm thấy phiên chat để báo cáo.');
    }

    const isReporterParticipant = record.reporterId === session.userAId || record.reporterId === session.userBId;
    const expectedReportedUserId = record.reporterId === session.userAId ? session.userBId : session.userAId;
    if (!isReporterParticipant || record.reportedUserId !== expectedReportedUserId) {
      throw new Error('Người báo cáo và người bị báo cáo không thuộc phiên chat này.');
    }

    const messageIds = record.evidence.map((item) => item.messageId);
    if (new Set(messageIds).size !== messageIds.length) {
      throw new Error('Danh sách bằng chứng chứa tin nhắn trùng lặp.');
    }

    const sourceMessages =
      messageIds.length === 0
        ? []
        : await tx
            .select({
              id: messages.id,
              messageType: messages.messageType,
              encryptedDek: messages.encryptedDek,
              ciphertext: messages.ciphertext,
              iv: messages.iv,
              authTag: messages.authTag,
            })
            .from(messages)
            .where(and(eq(messages.sessionId, record.sessionId), inArray(messages.id, messageIds)));
    const sourceMessagesById = new Map(sourceMessages.map((message) => [message.id, message]));
    if (sourceMessagesById.size !== messageIds.length) {
      throw new Error('Một hoặc nhiều tin nhắn bằng chứng không thuộc phiên chat.');
    }

    const canonicalRecord: ReportRecord = {
      ...record,
      evidence: record.evidence.map(({ messageId }) => {
        const message = sourceMessagesById.get(messageId)!;
        return {
          messageId,
          messageType: message.messageType as MessageType,
          frozenEncryptedDek: message.encryptedDek,
          frozenCiphertext: message.ciphertext,
          iv: message.iv,
          authTag: message.authTag,
        };
      }),
    };

    const priority =
      canonicalRecord.reason === 'UNDERAGE' || canonicalRecord.reason === 'THREAT'
        ? 'URGENT'
        : canonicalRecord.reason === 'NONCONSENSUAL_MEDIA' || canonicalRecord.reason === 'HARASSMENT'
        ? 'HIGH'
        : 'MEDIUM';

    await tx.insert(reports).values({
      id: canonicalRecord.id,
      sessionId: canonicalRecord.sessionId,
      reporterId: canonicalRecord.reporterId,
      reportedUserId: canonicalRecord.reportedUserId,
      reason: canonicalRecord.reason,
      description: canonicalRecord.description,
      priority,
      status: canonicalRecord.status,
      createdAt: new Date(canonicalRecord.createdAt),
      expiresAt: canonicalRecord.expiresAt ? new Date(canonicalRecord.expiresAt) : null,
    });

    for (const item of canonicalRecord.evidence) {
      await tx.insert(reportEvidence).values({
        reportId: canonicalRecord.id,
        messageId: item.messageId,
        frozenEncryptedDek: item.frozenEncryptedDek,
        frozenCiphertext: item.frozenCiphertext,
        iv: item.iv,
        authTag: item.authTag,
        messageType: item.messageType,
        frozenAt: new Date(canonicalRecord.createdAt),
      });
    }
    await tx.insert(blockedUsers).values({
      blockerId: canonicalRecord.reporterId,
      blockedId: canonicalRecord.reportedUserId,
    }).onConflictDoNothing();
    await tx.delete(friendships).where(
      or(
        and(
          eq(friendships.user1Id, canonicalRecord.reporterId),
          eq(friendships.user2Id, canonicalRecord.reportedUserId)
        ),
        and(
          eq(friendships.user1Id, canonicalRecord.reportedUserId),
          eq(friendships.user2Id, canonicalRecord.reporterId)
        )
      )
    );


    return canonicalRecord;
  });
};

export class SafetyService {
  private blocks: Map<string, Set<string>> = new Map(); // blockerId -> Set of blockedUserIds
  private reports: Map<string, ReportRecord> = new Map(); // reportId -> report
  private auditLogs: AuditLogEntry[] = [];

  constructor(
    private readonly cryptoService: EnvelopeCryptoService,
    private readonly superAdminUserId: string = 'super-admin-root-001',
    private readonly persistReportRecord: ReportPersistence = persistReport,
    private readonly persistBlockRecord: BlockPersistence = persistBlock
  ) {}

  /**
   * T037: Instant 2-way block (BLOCK-02)
   * Stops communication and revokes friendship if active
   */
  async blockUser(blockerId: string, blockedId: string): Promise<{ status: string }> {
    if (blockerId === blockedId) {
      throw new Error('Không thể tự chặn chính mình.');
    }

    await this.persistBlockRecord(blockerId, blockedId);

    if (!this.blocks.has(blockerId)) {
      this.blocks.set(blockerId, new Set());
    }
    this.blocks.get(blockerId)!.add(blockedId);
    return { status: 'BLOCKED' };
  }

  /**
   * Unblock a previously blocked user (S12 / Profile settings)
   */
  async unblockUser(blockerId: string, blockedId: string): Promise<{ status: string }> {
    if (!isUuid(blockerId) || !isUuid(blockedId)) {
      throw new Error('ID tài khoản không hợp lệ.');
    }
    await db.delete(blockedUsers).where(
      and(eq(blockedUsers.blockerId, blockerId), eq(blockedUsers.blockedId, blockedId))
    );
    this.blocks.get(blockerId)?.delete(blockedId);
    return { status: 'UNBLOCKED' };
  }

  /**
   * List users blocked by blockerId (S12 / Profile settings)
   */
  async listBlockedUsers(blockerId: string): Promise<Array<{ userId: string; nickname: string; gender: string; age: number; blockedAt: string }>> {
    if (!isUuid(blockerId)) {
      throw new Error('ID tài khoản không hợp lệ.');
    }
    const rows = await db
      .select({
        userId: blockedUsers.blockedId,
        blockedAt: blockedUsers.createdAt,
        nickname: profiles.nickname,
        gender: profiles.gender,
        calculatedAge: profiles.calculatedAge,
      })
      .from(blockedUsers)
      .innerJoin(profiles, eq(blockedUsers.blockedId, profiles.userId))
      .where(eq(blockedUsers.blockerId, blockerId))
      .orderBy(desc(blockedUsers.createdAt));

    return rows.map((r) => ({
      userId: r.userId,
      nickname: r.nickname,
      gender: r.gender,
      age: r.calculatedAge,
      blockedAt: r.blockedAt.toISOString(),
    }));
  }

  /**
   * Submit an appeal against account restriction (PRO-05)
   */
  async createAppeal(userId: string, reason: string): Promise<{
    id: string;
    userId: string;
    reason: string;
    status: 'PENDING' | 'APPROVED' | 'REJECTED';
    createdAt: string;
  }> {
    if (!isUuid(userId)) {
      throw new Error('ID tài khoản không hợp lệ.');
    }
    const trimmedReason = (reason || '').trim();
    if (trimmedReason.length < 10) {
      throw new Error('Lý do khiếu nại phải có ít nhất 10 ký tự.');
    }

    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) {
      throw new Error('Tài khoản không tồn tại.');
    }

    const [existingPending] = await db
      .select({ id: restrictionAppeals.id })
      .from(restrictionAppeals)
      .where(
        and(
          eq(restrictionAppeals.userId, userId),
          eq(restrictionAppeals.status, 'PENDING')
        )
      )
      .limit(1);
    if (existingPending) {
      throw new Error('Bạn đã có đơn khiếu nại đang chờ xử lý.');
    }

    const [appeal] = await db
      .insert(restrictionAppeals)
      .values({
        userId,
        reason: trimmedReason,
        status: 'PENDING',
      })
      .returning();

    return {
      id: appeal.id,
      userId: appeal.userId,
      reason: appeal.reason,
      status: appeal.status as 'PENDING' | 'APPROVED' | 'REJECTED',
      createdAt: appeal.createdAt.toISOString(),
    };
  }

  /**
   * List appeals submitted by a specific user
   */
  async listUserAppeals(userId: string): Promise<Array<{
    id: string;
    reason: string;
    status: 'PENDING' | 'APPROVED' | 'REJECTED';
    adminNote: string | null;
    createdAt: string;
    reviewedAt: string | null;
  }>> {
    if (!isUuid(userId)) {
      throw new Error('ID tài khoản không hợp lệ.');
    }
    const rows = await db
      .select({
        id: restrictionAppeals.id,
        reason: restrictionAppeals.reason,
        status: restrictionAppeals.status,
        adminNote: restrictionAppeals.adminNote,
        createdAt: restrictionAppeals.createdAt,
        reviewedAt: restrictionAppeals.reviewedAt,
      })
      .from(restrictionAppeals)
      .where(eq(restrictionAppeals.userId, userId))
      .orderBy(desc(restrictionAppeals.createdAt));

    return rows.map((r) => ({
      id: r.id,
      reason: r.reason,
      status: r.status as 'PENDING' | 'APPROVED' | 'REJECTED',
      adminNote: r.adminNote,
      createdAt: r.createdAt.toISOString(),
      reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
    }));
  }

  async isBlocked(userA: string, userB: string): Promise<boolean> {
    const aBlockedB = this.blocks.get(userA)?.has(userB) ?? false;
    const bBlockedA = this.blocks.get(userB)?.has(userA) ?? false;
    if (aBlockedB || bBlockedA) return true;
    if (!isUuid(userA) || !isUuid(userB)) return false;

    const [block] = await db
      .select({ id: blockedUsers.id })
      .from(blockedUsers)
      .where(
        or(
          and(eq(blockedUsers.blockerId, userA), eq(blockedUsers.blockedId, userB)),
          and(eq(blockedUsers.blockerId, userB), eq(blockedUsers.blockedId, userA))
        )
      )
      .limit(1);
    return Boolean(block);
  }

  /**
   * T038: Keep evidence through report handling and for 90 days after closure (REPORT-05)
   */
  async createReport(dto: CreateReportDto): Promise<{ reportId: string; expiresAt: string | null }> {
    const reportId = crypto.randomUUID();
    const now = new Date();

    const record: ReportInput = {
      id: reportId,
      sessionId: dto.sessionId,
      reporterId: dto.reporterId,
      reportedUserId: dto.reportedUserId,
      reason: dto.reason,
      description: dto.description,
      status: 'OPEN',
      createdAt: now.toISOString(),
      expiresAt: null,
      evidence: dto.evidenceMessages.map(({ messageId }) => ({ messageId })),
    };

    let savedRecord: ReportRecord;
    try {
      savedRecord = await this.persistReportRecord(record);
    } catch (err: unknown) {
      throw new Error('Không thể lưu báo cáo và bằng chứng vào cơ sở dữ liệu.', { cause: err });
    }

    this.reports.set(savedRecord.id, savedRecord);


    if (!this.blocks.has(dto.reporterId)) {
      this.blocks.set(dto.reporterId, new Set());
    }
    this.blocks.get(dto.reporterId)!.add(dto.reportedUserId);

    return {
      reportId,
      expiresAt: savedRecord.expiresAt,
    };
  }

  /**
   * Report an offending message inside a public/private community group & freeze evidence
   */
  async createGroupMessageReport(input: {
    reporterId: string;
    roomId: string;
    groupMessageId: string;
    reason: ReportReason;
    description?: string;
  }): Promise<{ reportId: string; priority: string; status: 'OPEN' }> {
    const allowedReasons: ReportReason[] = [
      'UNDERAGE',
      'HARASSMENT',
      'NONCONSENSUAL_MEDIA',
      'THREAT',
      'SPAM',
      'OTHER',
    ];
    if (!allowedReasons.includes(input.reason)) {
      throw new Error('Lý do báo cáo không hợp lệ.');
    }
    if (!isUuid(input.reporterId) || !isUuid(input.roomId) || !isUuid(input.groupMessageId)) {
      throw new Error('ID báo cáo nhóm không hợp lệ.');
    }

    const reportId = crypto.randomUUID();
    const now = new Date();
    const priority =
      input.reason === 'UNDERAGE' || input.reason === 'THREAT'
        ? 'URGENT'
        : input.reason === 'NONCONSENSUAL_MEDIA' || input.reason === 'HARASSMENT'
          ? 'HIGH'
          : 'MEDIUM';

    const reportedUserId = await db.transaction(async (tx) => {
      const [room] = await tx
        .select()
        .from(communityRooms)
        .where(and(eq(communityRooms.id, input.roomId), eq(communityRooms.isActive, true)))
        .limit(1);
      if (!room) throw new Error('Nhóm hoặc kênh không tồn tại.');

      if (input.reporterId !== this.superAdminUserId) {
        const [member] = await tx
          .select()
          .from(communityMembers)
          .where(and(eq(communityMembers.roomId, input.roomId), eq(communityMembers.userId, input.reporterId)))
          .limit(1);
        if (!member || (room.type === 'PRIVATE_PASSCODE' && !member.passcodeVerifiedAt)) {
          throw new Error('Bạn phải là thành viên phòng để báo cáo tin nhắn này.');
        }
      }

      const [msg] = await tx
        .select()
        .from(communityMessages)
        .where(
          and(
            eq(communityMessages.id, input.groupMessageId),
            eq(communityMessages.roomId, input.roomId),
            isNull(communityMessages.deletedAt)
          )
        )
        .limit(1);
      if (!msg) throw new Error('Không tìm thấy tin nhắn nhóm để báo cáo.');
      if (msg.senderId === input.reporterId) {
        throw new Error('Không thể tự báo cáo tin nhắn của chính mình.');
      }
      if (msg.senderId === this.superAdminUserId) {
        throw new Error('Không thể báo cáo thông báo chính thức của Quản trị viên.');
      }

      await tx.insert(reports).values({
        id: reportId,
        sessionId: null,
        roomId: input.roomId,
        reporterId: input.reporterId,
        reportedUserId: msg.senderId,
        reason: input.reason,
        description: input.description?.trim().slice(0, 1000) || null,
        priority,
        status: 'OPEN',
        createdAt: now,
        expiresAt: null,
      });

      await tx.insert(reportEvidence).values({
        reportId,
        messageId: null,
        groupMessageId: msg.id,
        frozenEncryptedDek: msg.encryptedDek,
        frozenCiphertext: msg.ciphertext,
        iv: msg.iv,
        authTag: msg.authTag,
        messageType: msg.messageType,
        frozenAt: now,
      });

      await tx
        .insert(blockedUsers)
        .values({ blockerId: input.reporterId, blockedId: msg.senderId })
        .onConflictDoNothing();

      await tx.delete(friendships).where(
        or(
          and(eq(friendships.user1Id, input.reporterId), eq(friendships.user2Id, msg.senderId)),
          and(eq(friendships.user1Id, msg.senderId), eq(friendships.user2Id, input.reporterId))
        )
      );

      return msg.senderId;
    });

    if (!this.blocks.has(input.reporterId)) {
      this.blocks.set(input.reporterId, new Set());
    }
    this.blocks.get(input.reporterId)!.add(reportedUserId);

    return { reportId, priority, status: 'OPEN' };
  }

  /**
   * T039, T040, T041: Super Admin opens report evidence with MANDATORY AuditLog
   */
  async openReportForAdjudication(
    actorId: string,
    reportId: string,
    ipAddress?: string
  ): Promise<{
    report: Omit<ReportRecord, 'evidence'>;
    decryptedMessages: Array<{ messageId: string; plaintext: string }>;
  }> {
    // T039 & T041: Only the designated Super Admin can open report evidence
    if (actorId !== this.superAdminUserId) {
      throw new Error('Từ chối truy cập: Chỉ Quản trị viên Tối cao duy nhất mới có quyền xem bằng chứng.');
    }

    const report = this.reports.get(reportId);
    if (!report) {
      throw new Error('Báo cáo không tồn tại hoặc đã hết hạn.');
    }

    // Closed reports expire 90 days after resolution.
    if (report.expiresAt !== null && new Date(report.expiresAt).getTime() < Date.now()) {
      throw new Error('Hồ sơ báo cáo đã hết hạn lưu trữ 90 ngày và đã bị tiêu hủy.');
    }

    // T040: Compulsory AuditLog entry (Non-Negotiable)
    const logEntry: AuditLogEntry = {
      id: `audit-${Date.now()}`,
      actorId,
      action: 'OPEN_REPORT_EVIDENCE',
      targetResourceId: reportId,
      ipAddress,
      timestamp: new Date().toISOString(),
    };
    this.auditLogs.push(logEntry);

    // Decrypt frozen evidence
    const decryptedMessages = await Promise.all(
      report.evidence.map(async (item) => {
        const plaintext = await this.cryptoService.decrypt({
          encryptedDek: item.frozenEncryptedDek,
          iv: item.iv,
          authTag: item.authTag,
          ciphertext: item.frozenCiphertext,
        });
        return {
          messageId: item.messageId,
          plaintext,
        };
      })
    );

    const { evidence: _evidence, ...reportMeta } = report;
    return {
      report: reportMeta,
      decryptedMessages,
    };
  }

  getAuditLogs(): AuditLogEntry[] {
    return this.auditLogs;
  }
}

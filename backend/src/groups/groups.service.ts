import crypto from 'node:crypto';
import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../database/index.js';
import { communityMembers, communityMessages, communityRooms } from '../database/schema/groups.js';
import { blockedUsers } from '../database/schema/friends.js';
import { profiles, users } from '../database/schema/users.js';
import { EnvelopeCryptoService } from '../crypto/envelope.service.js';
import { PasswordUtil } from '../auth/password.util.js';
import { config } from '../config/env.js';
import { ApiError } from '../http/api-error.js';

export type CommunityRoomType = 'BROADCAST' | 'PUBLIC' | 'PRIVATE_PASSCODE';

export interface CommunityRoomDto {
  id: string;
  name: string;
  description: string | null;
  type: CommunityRoomType;
  memberCount: number;
  isJoined: boolean;
  isUnlocked: boolean;
  canPost: boolean;
  createdAt: string;
}

export interface CommunityMessageDto {
  id: string;
  roomId: string;
  senderNickname: string;
  senderColor: string;
  isAdmin: boolean;
  isSelf: boolean;
  canReport?: boolean;
  messageType: string;
  content: string;
  sentAt: string;
}

const AVATAR_COLORS = [
  '#2563eb',
  '#7c3aed',
  '#db2777',
  '#059669',
  '#d97706',
  '#0891b2',
  '#4f46e5',
  '#be123c',
];

function avatarColorForUser(userId: string): string {
  const hash = crypto.createHash('sha256').update(userId).digest();
  return AVATAR_COLORS[hash[0]! % AVATAR_COLORS.length]!;
}

const isUuid = (val: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);

export class GroupsService {
  private onGroupMessage?: (roomId: string, msg: Omit<CommunityMessageDto, 'isSelf'> & { senderId: string }) => void;

  constructor(
    private readonly cryptoService: EnvelopeCryptoService,
    private readonly superAdminId: string = config.superAdminId
  ) {}

  setOnGroupMessage(
    handler: (roomId: string, msg: Omit<CommunityMessageDto, 'isSelf'> & { senderId: string }) => void
  ): void {
    this.onGroupMessage = handler;
  }

  private async assertActiveAdultUser(userId: string): Promise<void> {
    if (!isUuid(userId)) throw new Error('Mã người dùng không hợp lệ.');
    if (userId === this.superAdminId) return;
    const [user] = await db.select({ status: users.status }).from(users).where(eq(users.id, userId)).limit(1);
    if (!user || user.status === 'RESTRICTED' || user.status === 'DELETED') {
      throw new Error('Tài khoản đã bị khóa hoặc không hợp lệ.');
    }
    const prof = await db.query.profiles.findFirst({ where: eq(profiles.userId, userId) });
    if (!prof || prof.calculatedAge < 18) {
      throw new Error('Dịch vụ chỉ dành cho thành viên từ đủ 18 tuổi.');
    }
  }

  async ensureDefaultRooms(): Promise<void> {
    const existing = await db.select({ id: communityRooms.id }).from(communityRooms).limit(1);
    if (existing.length > 0) return;

    const adminUser = await db.query.users.findFirst({ where: eq(users.id, this.superAdminId) });
    if (!adminUser) return;

    await db.insert(communityRooms).values([
      {
        name: 'Thông báo chính thức Chatible',
        description: 'Kênh thông báo một chiều từ Ban Quản Trị (cập nhật tính năng, bảo trì, chính sách).',
        type: 'BROADCAST',
        createdBy: this.superAdminId,
      },
      {
        name: 'Sảnh trò chuyện cộng đồng',
        description: 'Nhóm chat công khai cho toàn thể thành viên Chatible giao lưu.',
        type: 'PUBLIC',
        createdBy: this.superAdminId,
      },
    ]);
  }

  async listRooms(userId?: string): Promise<CommunityRoomDto[]> {
    const rooms = await db
      .select()
      .from(communityRooms)
      .where(eq(communityRooms.isActive, true))
      .orderBy(asc(communityRooms.createdAt));

    return Promise.all(
      rooms.map(async (room) => {
        const [countRow] = await db
          .select({ count: sql<number>`count(*)` })
          .from(communityMembers)
          .where(eq(communityMembers.roomId, room.id));

        let membership = null;
        if (userId && isUuid(userId)) {
          const [m] = await db
            .select()
            .from(communityMembers)
            .where(and(eq(communityMembers.roomId, room.id), eq(communityMembers.userId, userId)))
            .limit(1);
          membership = m ?? null;
        }

        const isAdmin = userId === this.superAdminId;
        const isJoined = Boolean(membership) || isAdmin;
        const isUnlocked =
          room.type !== 'PRIVATE_PASSCODE' ? isJoined : isAdmin || Boolean(membership?.passcodeVerifiedAt);
        const canPost = room.type === 'BROADCAST' ? isAdmin : isUnlocked;

        return {
          id: room.id,
          name: room.name,
          description: room.description,
          type: room.type as CommunityRoomType,
          memberCount: Number(countRow?.count || 0),
          isJoined,
          isUnlocked,
          canPost,
          createdAt: room.createdAt.toISOString(),
        };
      })
    );
  }

  async createRoom(
    actorId: string,
    input: { name: string; description?: string; type: CommunityRoomType; passcode?: string }
  ): Promise<CommunityRoomDto> {
    if (actorId !== this.superAdminId) {
      throw new Error('Chỉ Super Admin mới có quyền tạo Kênh hoặc Nhóm cộng đồng.');
    }
    const name = input.name?.trim();
    if (!name || name.length < 2 || name.length > 80) {
      throw new Error('Tên nhóm/kênh phải từ 2 đến 80 ký tự.');
    }
    if (!['BROADCAST', 'PUBLIC', 'PRIVATE_PASSCODE'].includes(input.type)) {
      throw new Error('Loại nhóm/kênh không hợp lệ.');
    }

    let passcodeHash: string | null = null;
    if (input.type === 'PRIVATE_PASSCODE') {
      const passcode = input.passcode?.trim() || '';
      if (passcode.length < 4 || passcode.length > 32) {
        throw new Error('Nhóm bảo mật cần mã mật khẩu từ 4 đến 32 ký tự.');
      }
      passcodeHash = PasswordUtil.hash(passcode);
    }

    const [created] = await db
      .insert(communityRooms)
      .values({
        name,
        description: input.description?.trim().slice(0, 255) || null,
        type: input.type,
        passcodeHash,
        createdBy: actorId,
      })
      .returning();

    return {
      id: created!.id,
      name: created!.name,
      description: created!.description,
      type: created!.type as CommunityRoomType,
      memberCount: 0,
      isJoined: true,
      isUnlocked: true,
      canPost: true,
      createdAt: created!.createdAt.toISOString(),
    };
  }

  async joinRoom(userId: string, roomId: string, passcode?: string): Promise<{ joined: boolean; unlocked: boolean }> {
    await this.assertActiveAdultUser(userId);
    if (!isUuid(roomId)) throw new Error('Mã phòng không hợp lệ.');

    const [room] = await db
      .select()
      .from(communityRooms)
      .where(and(eq(communityRooms.id, roomId), eq(communityRooms.isActive, true)))
      .limit(1);
    if (!room) throw new Error('Nhóm hoặc kênh không tồn tại.');

    let verifiedAt: Date | null = null;
    if (room.type === 'PRIVATE_PASSCODE') {
      if (userId === this.superAdminId) {
        verifiedAt = new Date();
      } else {
        const cleanPasscode = passcode?.trim() || '';
        if (!room.passcodeHash || !cleanPasscode || !PasswordUtil.verify(cleanPasscode, room.passcodeHash)) {
          throw ApiError.forbidden('Mã mật khẩu vào nhóm bảo mật không chính xác.');
        }
        verifiedAt = new Date();
      }
    }

    const now = new Date();
    const values = {
      roomId,
      userId,
      role: userId === this.superAdminId ? 'ADMIN' : 'MEMBER',
      passcodeVerifiedAt: verifiedAt,
      joinedAt: now,
    };
    if (verifiedAt) {
      await db
        .insert(communityMembers)
        .values(values)
        .onConflictDoUpdate({
          target: [communityMembers.roomId, communityMembers.userId],
          set: { passcodeVerifiedAt: verifiedAt },
        });
    } else {
      await db
        .insert(communityMembers)
        .values(values)
        .onConflictDoNothing({
          target: [communityMembers.roomId, communityMembers.userId],
        });
    }

    return { joined: true, unlocked: room.type !== 'PRIVATE_PASSCODE' || Boolean(verifiedAt) };
  }

  async hasRoomAccess(userId: string, roomId: string): Promise<boolean> {
    if (!isUuid(userId) || !isUuid(roomId)) return false;
    const [room] = await db
      .select()
      .from(communityRooms)
      .where(and(eq(communityRooms.id, roomId), eq(communityRooms.isActive, true)))
      .limit(1);
    if (!room) return false;
    if (userId === this.superAdminId) return true;

    const [member] = await db
      .select()
      .from(communityMembers)
      .where(and(eq(communityMembers.roomId, roomId), eq(communityMembers.userId, userId)))
      .limit(1);

    if (room.type === 'PRIVATE_PASSCODE') {
      return Boolean(member?.passcodeVerifiedAt);
    }
    return Boolean(member);
  }

  async listMessages(userId: string, roomId: string, limit = 60): Promise<CommunityMessageDto[]> {
    await this.assertActiveAdultUser(userId);
    if (!(await this.hasRoomAccess(userId, roomId))) {
      throw ApiError.forbidden('Bạn cần tham gia hoặc nhập đúng mật khẩu để xem nội dung phòng này.');
    }

    const now = new Date();
    const blockRows = await db
      .select({ blockerId: blockedUsers.blockerId, blockedId: blockedUsers.blockedId })
      .from(blockedUsers)
      .where(or(eq(blockedUsers.blockerId, userId), eq(blockedUsers.blockedId, userId)));
    const blockedPeers = new Set<string>();
    for (const row of blockRows) {
      blockedPeers.add(row.blockerId === userId ? row.blockedId : row.blockerId);
    }

    const rows = await db
      .select()
      .from(communityMessages)
      .where(
        and(
          eq(communityMessages.roomId, roomId),
          isNull(communityMessages.deletedAt),
          gt(communityMessages.expiresAt, now)
        )
      )
      .orderBy(asc(communityMessages.acceptedAt))
      .limit(Math.min(100, Math.max(1, limit)));

    const visibleRows = rows.filter(
      (m) => m.senderId === this.superAdminId || !blockedPeers.has(m.senderId)
    );

    const senderIds = Array.from(
      new Set(visibleRows.filter((m) => m.senderId !== this.superAdminId).map((m) => m.senderId))
    );
    const senderProfiles = senderIds.length > 0
      ? await db
          .select({ userId: profiles.userId, nickname: profiles.nickname })
          .from(profiles)
          .where(inArray(profiles.userId, senderIds))
      : [];
    const nicknameMap = new Map(senderProfiles.map((p) => [p.userId, p.nickname]));

    return Promise.all(
      visibleRows.map(async (m) => {
        const isAdminSender = m.senderId === this.superAdminId;
        const nickname = isAdminSender ? null : nicknameMap.get(m.senderId);
        const content = await this.cryptoService
          .decrypt({
            encryptedDek: m.encryptedDek,
            iv: m.iv,
            authTag: m.authTag,
            ciphertext: m.ciphertext,
          })
          .catch(() => '[Không thể giải mã]');

        return {
          id: m.id,
          roomId: m.roomId,
          senderNickname: isAdminSender ? 'Quản trị viên Chatible' : (nickname || 'Thành viên'),
          senderColor: isAdminSender ? '#dc2626' : avatarColorForUser(m.senderId),
          isAdmin: isAdminSender,
          isSelf: m.senderId === userId,
          canReport: m.senderId !== userId && !isAdminSender,
          messageType: m.messageType,
          content,
          sentAt: m.acceptedAt.toISOString(),
        };
      })
    );
  }

  async getMessageAuthorForMember(
    userId: string,
    roomId: string,
    messageId: string
  ): Promise<{ senderId: string; isAdmin: boolean }> {
    await this.assertActiveAdultUser(userId);
    if (!isUuid(roomId) || !isUuid(messageId)) {
      throw new Error('ID phòng hoặc tin nhắn không hợp lệ.');
    }
    if (!(await this.hasRoomAccess(userId, roomId))) {
      throw new Error('Bạn chưa tham gia hoặc mở khóa phòng này.');
    }
    const [msg] = await db
      .select({ senderId: communityMessages.senderId })
      .from(communityMessages)
      .where(
        and(
          eq(communityMessages.id, messageId),
          eq(communityMessages.roomId, roomId),
          isNull(communityMessages.deletedAt)
        )
      )
      .limit(1);
    if (!msg) throw new Error('Tin nhắn không tồn tại hoặc đã bị gỡ.');
    return { senderId: msg.senderId, isAdmin: msg.senderId === this.superAdminId };
  }

  async postMessage(
    userId: string,
    roomId: string,
    input: { content: string; type?: string }
  ): Promise<CommunityMessageDto> {
    await this.assertActiveAdultUser(userId);
    if (!isUuid(roomId)) throw new Error('Mã phòng không hợp lệ.');

    const [room] = await db
      .select()
      .from(communityRooms)
      .where(and(eq(communityRooms.id, roomId), eq(communityRooms.isActive, true)))
      .limit(1);
    if (!room) throw new Error('Nhóm hoặc kênh không tồn tại.');

    if (room.type === 'BROADCAST' && userId !== this.superAdminId) {
      throw ApiError.forbidden('Kênh thông báo chỉ cho phép Quản trị viên đăng tin.');
    }

    if (!(await this.hasRoomAccess(userId, roomId))) {
      throw ApiError.forbidden('Bạn chưa mở khóa hoặc tham gia nhóm này.');
    }

    const content = (input.content || '').trim();
    if (!content) throw new Error('Nội dung tin nhắn không được để trống.');
    if (content.length > 4000) throw new Error('Tin nhắn vượt quá 4000 ký tự.');

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const encrypted = await this.cryptoService.encrypt(content);

    const [saved] = await db
      .insert(communityMessages)
      .values({
        roomId,
        senderId: userId,
        messageType: input.type || 'TEXT',
        encryptedDek: encrypted.encryptedDek,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        ciphertext: encrypted.ciphertext,
        acceptedAt: now,
        expiresAt,
      })
      .returning();

    const isAdminSender = userId === this.superAdminId;
    const prof = isAdminSender
      ? null
      : await db.query.profiles.findFirst({ where: eq(profiles.userId, userId) });
    const senderNickname = isAdminSender ? 'Quản trị viên Chatible' : (prof?.nickname || 'Thành viên');
    const senderColor = isAdminSender ? '#dc2626' : avatarColorForUser(userId);

    const broadcastPayload = {
      id: saved!.id,
      roomId,
      senderId: userId,
      senderNickname,
      senderColor,
      isAdmin: isAdminSender,
      messageType: saved!.messageType,
      content,
      sentAt: now.toISOString(),
    };

    this.onGroupMessage?.(roomId, broadcastPayload);

    return {
      ...broadcastPayload,
      isSelf: true,
    };
  }
}

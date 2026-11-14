import { Gender, MessageType } from '@chatible/shared';
import { and, desc, eq, gt, inArray, lt, or } from 'drizzle-orm';
import crypto from 'node:crypto';
import { db } from '../database/index.js';
import { chatSessions } from '../database/schema/sessions.js';
import { friendships, friendRequests, blockedUsers } from '../database/schema/friends.js';
import { messages } from '../database/schema/messages.js';
import { profiles, users } from '../database/schema/users.js';
import { EnvelopeCryptoService } from '../crypto/envelope.service.js';
import { ApiError } from '../http/api-error.js';
import { MediaService } from '../media/media.service.js';
const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export const DEFAULT_FRIEND_MESSAGES_PAGE_SIZE = 40;
export const MAX_FRIEND_MESSAGES_PAGE_SIZE = 100;

export interface FriendSummary {
  id: string;
  userId: string;
  nickname: string;
  gender: Gender;
  age: number;
  isOnline: boolean;
  establishedAt: string;
}

export interface FriendRequestSummary {
  requestId: string;
  fromUserId: string;
  nickname: string;
  gender: Gender;
  age: number;
  sentAt: string;
}

export interface FriendMessageDto {
  id: string;
  sessionId?: string;
  senderId: string;
  receiverId: string;
  messageType: MessageType;
  content: string;
  metadata?: unknown;
  isAdultContent?: boolean;
  sentAt: string;
  expiresAt: string; // 30 days after sent
}

export interface FriendConversationPage {
  messages: FriendMessageDto[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface FriendConversationPaginationOptions {
  before?: string;
  limit?: number;
}

export interface SendFriendMessageInput {
  content: string;
  type?: MessageType;
  mediaId?: string;
  isAdultContent?: boolean;
  metadata?: Record<string, unknown>;
  clientMessageId?: string;
}

export class FriendsService {
  private onFriendMessage?: (toUserId: string, msg: FriendMessageDto) => void;

  constructor(
    private readonly cryptoService: EnvelopeCryptoService,
    private readonly mediaService: MediaService = new MediaService()
  ) {}

  setOnFriendMessage(handler: (toUserId: string, msg: FriendMessageDto) => void): void {
    this.onFriendMessage = handler;
  }

  private async assertUserActive(userId: string): Promise<void> {
    const [user] = await db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user || user.status === 'RESTRICTED' || user.status === 'DELETED') {
      throw new Error('Tài khoản của bạn đã bị khóa hoặc đình chỉ do vi phạm chính sách cộng đồng.');
    }
  }

  /**
   * T032: Send friend request from active chat or recent session (FRI-01)
   */
  async sendFriendRequest(fromUserId: string, toUserId: string): Promise<{ requestId: string; message: string }> {
    await this.assertUserActive(fromUserId);
    if (fromUserId === toUserId) {
      throw new Error('Không thể tự kết bạn với chính mình.');
    }
    if (!isUuid(fromUserId) || !isUuid(toUserId)) {
      throw new Error('ID tài khoản không hợp lệ.');
    }

    const requestId = crypto.randomUUID();
    const now = new Date();
    await db.transaction(async (tx) => {
      const [sharedSession] = await tx
        .select({ id: chatSessions.id })
        .from(chatSessions)
        .where(
          and(
            or(
              and(eq(chatSessions.userAId, fromUserId), eq(chatSessions.userBId, toUserId)),
              and(eq(chatSessions.userAId, toUserId), eq(chatSessions.userBId, fromUserId))
            ),
            or(eq(chatSessions.status, 'ACTIVE'), gt(chatSessions.expiresAt, now))
          )
        )
        .limit(1);
      if (!sharedSession) {
        throw new Error('Chỉ có thể kết bạn với người từng trò chuyện trong một phiên còn hiệu lực.');
      }

      const [block] = await tx
        .select({ id: blockedUsers.id })
        .from(blockedUsers)
        .where(
          or(
            and(eq(blockedUsers.blockerId, fromUserId), eq(blockedUsers.blockedId, toUserId)),
            and(eq(blockedUsers.blockerId, toUserId), eq(blockedUsers.blockedId, fromUserId))
          )
        )
        .limit(1);
      if (block) throw new Error('Không thể gửi lời mời giữa các tài khoản đã chặn nhau.');

      const [friendship] = await tx
        .select({ id: friendships.id })
        .from(friendships)
        .where(
          or(
            and(eq(friendships.user1Id, fromUserId), eq(friendships.user2Id, toUserId)),
            and(eq(friendships.user1Id, toUserId), eq(friendships.user2Id, fromUserId))
          )
        )
        .limit(1);
      if (friendship) throw new Error('Hai bạn đã là bạn bè.');

      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      const [pendingRequest] = await tx
        .select({ id: friendRequests.id })
        .from(friendRequests)
        .where(
          and(
            eq(friendRequests.status, 'PENDING'),
            gt(friendRequests.createdAt, sevenDaysAgo),
            or(
              and(eq(friendRequests.fromUserId, fromUserId), eq(friendRequests.toUserId, toUserId)),
              and(eq(friendRequests.fromUserId, toUserId), eq(friendRequests.toUserId, fromUserId))
            )
          )
        )
        .limit(1);
      if (pendingRequest) throw new Error('Đã có lời mời kết bạn đang chờ xử lý.');

      const [recentCooldown] = await tx
        .select({ id: friendRequests.id })
        .from(friendRequests)
        .where(
          and(
            or(
              and(eq(friendRequests.fromUserId, fromUserId), eq(friendRequests.toUserId, toUserId)),
              and(eq(friendRequests.fromUserId, toUserId), eq(friendRequests.toUserId, fromUserId))
            ),
            or(eq(friendRequests.status, 'DECLINED'), eq(friendRequests.status, 'CANCELLED')),
            gt(friendRequests.updatedAt, sevenDaysAgo)
          )
        )
        .limit(1);
      if (recentCooldown) {
        throw new Error('Lời mời đã bị từ chối hoặc thu hồi gần đây. Vui lòng chờ 7 ngày trước khi gửi lại.');
      }

      await tx.insert(friendRequests).values({
        id: requestId,
        fromUserId,
        toUserId,
        status: 'PENDING',
      });
    });

    return { requestId, message: 'Đã gửi lời mời kết bạn thành công.' };
  }

  /**
   * T032: Accept a pending request only by its intended recipient.
   */
  async acceptFriendRequest(requestId: string, recipientId: string): Promise<{ status: string }> {
    if (!isUuid(requestId) || !isUuid(recipientId)) {
      throw new Error('ID lời mời hoặc tài khoản không hợp lệ.');
    }
    await this.assertUserActive(recipientId);

    await db.transaction(async (tx) => {
      const [request] = await tx
        .select({
          fromUserId: friendRequests.fromUserId,
          toUserId: friendRequests.toUserId,
          createdAt: friendRequests.createdAt,
        })
        .from(friendRequests)
        .where(
          and(
            eq(friendRequests.id, requestId),
            eq(friendRequests.toUserId, recipientId),
            eq(friendRequests.status, 'PENDING')
          )
        )
        .limit(1)
        .for('update');
      if (!request) {
        throw new Error('Lời mời không tồn tại, đã xử lý hoặc không dành cho tài khoản này.');
      }

      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      if (request.createdAt <= sevenDaysAgo) {
        throw new Error('Lời mời kết bạn đã hết hạn.');
      }

      const [block] = await tx
        .select({ id: blockedUsers.id })
        .from(blockedUsers)
        .where(
          or(
            and(eq(blockedUsers.blockerId, request.fromUserId), eq(blockedUsers.blockedId, recipientId)),
            and(eq(blockedUsers.blockerId, recipientId), eq(blockedUsers.blockedId, request.fromUserId))
          )
        )
        .limit(1);
      if (block) throw new Error('Không thể chấp nhận lời mời giữa các tài khoản đã chặn nhau.');

      const [acceptedRequest] = await tx
        .update(friendRequests)
        .set({ status: 'ACCEPTED', updatedAt: new Date() })
        .where(
          and(
            eq(friendRequests.id, requestId),
            eq(friendRequests.toUserId, recipientId),
            eq(friendRequests.status, 'PENDING')
          )
        )
        .returning({ id: friendRequests.id });
      if (!acceptedRequest) throw new Error('Lời mời đã được xử lý.');

      const u1 = request.fromUserId < recipientId ? request.fromUserId : recipientId;
      const u2 = request.fromUserId < recipientId ? recipientId : request.fromUserId;
      await tx
        .insert(friendships)
        .values({
          user1Id: u1,
          user2Id: u2,
          status: 'ACCEPTED',
        })
        .onConflictDoNothing();
    });

    return { status: 'ACCEPTED' };
  }

  /**
   * Decline a pending friend request (PRO-03)
   * Sets status to DECLINED which triggers a 7-day cooldown on re-sending
   */
  async declineFriendRequest(requestId: string, recipientId: string): Promise<{ status: string }> {
    if (!isUuid(requestId) || !isUuid(recipientId)) {
      throw new Error('ID lời mời hoặc tài khoản không hợp lệ.');
    }
    await this.assertUserActive(recipientId);

    const [updated] = await db
      .update(friendRequests)
      .set({
        status: 'DECLINED',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(friendRequests.id, requestId),
          eq(friendRequests.toUserId, recipientId),
          eq(friendRequests.status, 'PENDING')
        )
      )
      .returning({ id: friendRequests.id });

    if (!updated) {
      throw new Error('Lời mời không tồn tại, đã xử lý hoặc không dành cho tài khoản này.');
    }

    return { status: 'DECLINED' };
  }

  /**
   * Cancel / revoke a pending friend request by sender (PRO-03)
   * Sets status to CANCELLED which triggers a 7-day cooldown on re-sending
   */
  async cancelFriendRequest(requestId: string, senderId: string): Promise<{ status: string }> {
    if (!isUuid(requestId) || !isUuid(senderId)) {
      throw new Error('ID lời mời hoặc tài khoản không hợp lệ.');
    }
    await this.assertUserActive(senderId);

    const [updated] = await db
      .update(friendRequests)
      .set({
        status: 'CANCELLED',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(friendRequests.id, requestId),
          eq(friendRequests.fromUserId, senderId),
          eq(friendRequests.status, 'PENDING')
        )
      )
      .returning({ id: friendRequests.id });

    if (!updated) {
      throw new Error('Lời mời không tồn tại, đã xử lý hoặc không phải do bạn gửi.');
    }

    return { status: 'CANCELLED' };
  }

  /**
   * Unfriend a user (FRI-01 / S11 / PRO-03)
   * Revokes friendship immediately.
   */
  async unfriend(userId: string, friendId: string): Promise<{ status: string }> {
    if (!isUuid(userId) || !isUuid(friendId)) {
      throw new Error('ID tài khoản không hợp lệ.');
    }
    await this.assertUserActive(userId);
    await this.breakFriendship(userId, friendId);
    return { status: 'UNFRIENDED' };
  }

  /**
   * Break friendship on block (BLOCK-02).
   */
  async breakFriendship(userA: string, userB: string): Promise<void> {
    if (!isUuid(userA) || !isUuid(userB)) return;
    await db.delete(friendships).where(
      or(
        and(eq(friendships.user1Id, userA), eq(friendships.user2Id, userB)),
        and(eq(friendships.user1Id, userB), eq(friendships.user2Id, userA))
      )
    );
  }

  async listIncomingRequests(userId: string): Promise<FriendRequestSummary[]> {
    if (!isUuid(userId)) return [];
    await this.assertUserActive(userId);

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const rows = await db
      .select({
        requestId: friendRequests.id,
        fromUserId: friendRequests.fromUserId,
        nickname: profiles.nickname,
        gender: profiles.gender,
        age: profiles.calculatedAge,
        sentAt: friendRequests.createdAt,
      })
      .from(friendRequests)
      .innerJoin(profiles, eq(profiles.userId, friendRequests.fromUserId))
      .where(
        and(
          eq(friendRequests.toUserId, userId),
          eq(friendRequests.status, 'PENDING'),
          gt(friendRequests.createdAt, sevenDaysAgo)
        )
      )
      .orderBy(desc(friendRequests.createdAt));

    return rows.map((row) => ({
      ...row,
      gender: row.gender as Gender,
      sentAt: row.sentAt.toISOString(),
    }));
  }

  async listFriends(userId: string): Promise<FriendSummary[]> {
    if (!isUuid(userId)) return [];
    await this.assertUserActive(userId);

    const rows = await db
      .select()
      .from(friendships)
      .where(or(eq(friendships.user1Id, userId), eq(friendships.user2Id, userId)));
    if (rows.length === 0) return [];

    const friendIds = Array.from(
      new Set(rows.map((row) => (row.user1Id === userId ? row.user2Id : row.user1Id)))
    );
    const friendProfiles = await db
      .select({
        userId: profiles.userId,
        nickname: profiles.nickname,
        gender: profiles.gender,
        calculatedAge: profiles.calculatedAge,
      })
      .from(profiles)
      .where(inArray(profiles.userId, friendIds));

    const profileMap = new Map(friendProfiles.map((p) => [p.userId, p]));
    const result: FriendSummary[] = [];
    for (const row of rows) {
      const friendId = row.user1Id === userId ? row.user2Id : row.user1Id;
      const profile = profileMap.get(friendId);
      if (!profile) continue;
      result.push({
        id: row.id,
        userId: friendId,
        nickname: profile.nickname,
        gender: profile.gender as Gender,
        age: profile.calculatedAge,
        isOnline: false,
        establishedAt: row.establishedAt.toISOString(),
      });
    }
    return result;
  }

  async isFriend(userA: string, userB: string): Promise<boolean> {
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
    if (block) return false;

    const [friendship] = await db
      .select({ id: friendships.id })
      .from(friendships)
      .where(
        or(
          and(eq(friendships.user1Id, userA), eq(friendships.user2Id, userB)),
          and(eq(friendships.user1Id, userB), eq(friendships.user2Id, userA))
        )
      )
      .limit(1);
    if (friendship) return true;

    // Check if there is an ACCEPTED friendRequest to auto-heal
    const [acceptedReq] = await db
      .select({ id: friendRequests.id })
      .from(friendRequests)
      .where(
        and(
          eq(friendRequests.status, 'ACCEPTED'),
          or(
            and(eq(friendRequests.fromUserId, userA), eq(friendRequests.toUserId, userB)),
            and(eq(friendRequests.fromUserId, userB), eq(friendRequests.toUserId, userA))
          )
        )
      )
      .limit(1);
    if (acceptedReq) {
      const u1 = userA < userB ? userA : userB;
      const u2 = userA < userB ? userB : userA;
      await db
        .insert(friendships)
        .values({ user1Id: u1, user2Id: u2, status: 'ACCEPTED' })
        .onConflictDoNothing();
      return true;
    }

    return false;
  }

  async getOrCreateFriendSession(
    userId: string,
    friendId: string
  ): Promise<{ sessionId: string; myAdultConsent: boolean; partnerAdultConsent: boolean }> {
    if (!isUuid(userId) || !isUuid(friendId) || userId === friendId) {
      throw new Error('ID bạn bè không hợp lệ.');
    }
    await this.assertUserActive(userId);
    if (!(await this.isFriend(userId, friendId))) {
      throw new Error('Chỉ có bạn bè mới có thể mở luồng trò chuyện 1-1.');
    }
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const sessionId = await db.transaction(async (tx) => {
      const [block] = await tx
        .select({ id: blockedUsers.id })
        .from(blockedUsers)
        .where(
          or(
            and(eq(blockedUsers.blockerId, userId), eq(blockedUsers.blockedId, friendId)),
            and(eq(blockedUsers.blockerId, friendId), eq(blockedUsers.blockedId, userId))
          )
        )
        .limit(1);
      if (block) throw new Error('Không thể trò chuyện giữa các tài khoản đã chặn nhau.');

      let [session] = await tx
        .select({ id: chatSessions.id })
        .from(chatSessions)
        .where(
          and(
            eq(chatSessions.sessionType, 'FRIEND'),
            eq(chatSessions.status, 'ACTIVE'),
            gt(chatSessions.expiresAt, now),
            or(
              and(eq(chatSessions.userAId, userId), eq(chatSessions.userBId, friendId)),
              and(eq(chatSessions.userAId, friendId), eq(chatSessions.userBId, userId))
            )
          )
        )
        .orderBy(desc(chatSessions.startedAt))
        .limit(1);

      if (!session) {
        [session] = await tx
          .insert(chatSessions)
          .values({
            sessionType: 'FRIEND',
            userAId: userId,
            userBId: friendId,
            status: 'ACTIVE',
            expiresAt,
          })
          .returning({ id: chatSessions.id });
      }
      if (!session) throw new Error('Không thể khởi tạo phiên chat bạn bè.');
      return session.id;
    });

    const [myAdultConsent, partnerAdultConsent] = await Promise.all([
      this.mediaService.hasAdultConsent(sessionId, userId),
      this.mediaService.hasAdultConsent(sessionId, friendId),
    ]);

    return { sessionId, myAdultConsent, partnerAdultConsent };
  }

  async sendFriendMessage(
    fromUserId: string,
    toUserId: string,
    input: string | SendFriendMessageInput
  ): Promise<FriendMessageDto> {
    if (!isUuid(fromUserId) || !isUuid(toUserId) || fromUserId === toUserId) {
      throw new Error('ID tài khoản không hợp lệ.');
    }
    await this.assertUserActive(fromUserId);

    const normalizedInput: SendFriendMessageInput =
      typeof input === 'string' ? { content: input, type: 'TEXT' } : input;
    const messageType: MessageType = normalizedInput.type || 'TEXT';
    const trimmedContent = (normalizedInput.content || '').trim();
    if (!trimmedContent) throw new Error('Tin nhắn không được để trống.');
    if (trimmedContent.length > 4000) throw new Error('Tin nhắn vượt quá 4000 ký tự.');

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const encrypted = await this.cryptoService.encrypt(trimmedContent);

    const { sessionId, clientMessageId, metadata, isAdultContent } = await db.transaction(async (tx) => {
      const [friendship] = await tx
        .select({ id: friendships.id })
        .from(friendships)
        .where(
          or(
            and(eq(friendships.user1Id, fromUserId), eq(friendships.user2Id, toUserId)),
            and(eq(friendships.user1Id, toUserId), eq(friendships.user2Id, fromUserId))
          )
        )
        .limit(1)
        .for('update');
      if (!friendship) throw new Error('Chỉ có bạn bè mới có thể gửi tin nhắn 1-1 trực tiếp.');

      const [block] = await tx
        .select({ id: blockedUsers.id })
        .from(blockedUsers)
        .where(
          or(
            and(eq(blockedUsers.blockerId, fromUserId), eq(blockedUsers.blockedId, toUserId)),
            and(eq(blockedUsers.blockerId, toUserId), eq(blockedUsers.blockedId, fromUserId))
          )
        )
        .limit(1);
      if (block) throw new Error('Không thể nhắn tin giữa các tài khoản đã chặn nhau.');

      let [session] = await tx
        .select({ id: chatSessions.id })
        .from(chatSessions)
        .where(
          and(
            eq(chatSessions.sessionType, 'FRIEND'),
            eq(chatSessions.status, 'ACTIVE'),
            gt(chatSessions.expiresAt, now),
            or(
              and(eq(chatSessions.userAId, fromUserId), eq(chatSessions.userBId, toUserId)),
              and(eq(chatSessions.userAId, toUserId), eq(chatSessions.userBId, fromUserId))
            )
          )
        )
        .orderBy(desc(chatSessions.startedAt))
        .limit(1);

      if (!session) {
        [session] = await tx
          .insert(chatSessions)
          .values({
            sessionType: 'FRIEND',
            userAId: fromUserId,
            userBId: toUserId,
            status: 'ACTIVE',
            expiresAt,
          })
          .returning({ id: chatSessions.id });
      } else {
        await tx.update(chatSessions).set({ expiresAt }).where(eq(chatSessions.id, session.id));
      }
      if (!session) throw new Error('Không thể tạo phiên trò chuyện với bạn bè.');

      return {
        sessionId: session.id,
        clientMessageId: normalizedInput.clientMessageId?.trim().slice(0, 64) || null,
        metadata: normalizedInput.metadata || null,
        isAdultContent: Boolean(normalizedInput.isAdultContent),
      };
    });

    if (clientMessageId) {
      const [existing] = await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.sessionId, sessionId),
            eq(messages.senderId, fromUserId),
            eq(messages.clientMessageId, clientMessageId)
          )
        )
        .limit(1);
      if (existing) {
        return {
          id: existing.id,
          sessionId,
          senderId: fromUserId,
          receiverId: toUserId,
          messageType: existing.messageType as MessageType,
          content: trimmedContent,
          metadata: existing.metadata,
          isAdultContent: existing.isAdultContent,
          sentAt: existing.acceptedAt.toISOString(),
          expiresAt: existing.expiresAt.toISOString(),
        };
      }
    }

    let finalMetadata: Record<string, unknown> | null = metadata;
    let verifiedIsAdult = false;
    if (messageType !== 'TEXT') {
      let mediaId = normalizedInput.mediaId?.trim() || '';
      if (!mediaId) {
        try {
          const parsed = JSON.parse(trimmedContent) as { mediaId?: string; media_id?: string };
          mediaId = (parsed?.mediaId || parsed?.media_id || '').trim();
        } catch {
          // ignore
        }
      }
      if (!mediaId) {
        throw new Error('Tin nhắn media bạn bè bắt buộc gắn với mã mediaId hợp lệ.');
      }
      const verifiedAsset = await this.mediaService.verifyDeliverableMedia({
        mediaId,
        sessionId,
        senderId: fromUserId,
        recipientId: toUserId,
        mediaType: messageType,
        isAdultContent,
      });
      verifiedIsAdult = verifiedAsset.isAdult;
      finalMetadata = { ...(finalMetadata || {}), mediaId: verifiedAsset.id, isAdult: verifiedAsset.isAdult };
    }

    const [message] = await db
      .insert(messages)
      .values({
        sessionId,
        senderId: fromUserId,
        clientMessageId,
        messageType,
        encryptedDek: encrypted.encryptedDek,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        metadata: finalMetadata,
        isAdultContent: verifiedIsAdult,
        acceptedAt: now,
        expiresAt,
      })
      .returning({ id: messages.id });
    if (!message) throw new Error('Không thể lưu tin nhắn.');

    const dto: FriendMessageDto = {
      id: message.id,
      sessionId,
      senderId: fromUserId,
      receiverId: toUserId,
      messageType,
      content: trimmedContent,
      metadata: finalMetadata,
      isAdultContent: verifiedIsAdult,
      sentAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    this.onFriendMessage?.(toUserId, dto);
    return dto;
  }

  private encodeConversationCursor(acceptedAt: Date, id: string): string {
    return Buffer.from(JSON.stringify({ t: acceptedAt.toISOString(), id }), 'utf8').toString('base64url');
  }

  private decodeConversationCursor(cursor: string): { acceptedAt: Date; id: string } {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
        t?: unknown;
        id?: unknown;
      };
      if (typeof parsed.t !== 'string' || typeof parsed.id !== 'string' || !isUuid(parsed.id)) {
        throw new Error('Malformed cursor fields');
      }
      const acceptedAt = new Date(parsed.t);
      if (Number.isNaN(acceptedAt.getTime())) {
        throw new Error('Malformed cursor timestamp');
      }
      return { acceptedAt, id: parsed.id };
    } catch {
      throw ApiError.badRequest('Cursor phân trang không hợp lệ.');
    }
  }

  private normalizeConversationLimit(limit?: number): number {
    if (limit === undefined) return DEFAULT_FRIEND_MESSAGES_PAGE_SIZE;
    if (!Number.isFinite(limit) || Math.floor(limit) < 1) {
      throw ApiError.badRequest('Giới hạn phân trang phải là số nguyên dương.');
    }
    return Math.min(MAX_FRIEND_MESSAGES_PAGE_SIZE, Math.floor(limit));
  }

  private async findActiveFriendSession(
    userA: string,
    userB: string,
    now: Date
  ): Promise<{ id: string; userAId: string; userBId: string } | null> {
    const [session] = await db
      .select({ id: chatSessions.id, userAId: chatSessions.userAId, userBId: chatSessions.userBId })
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.sessionType, 'FRIEND'),
          eq(chatSessions.status, 'ACTIVE'),
          gt(chatSessions.expiresAt, now),
          or(
            and(eq(chatSessions.userAId, userA), eq(chatSessions.userBId, userB)),
            and(eq(chatSessions.userAId, userB), eq(chatSessions.userBId, userA))
          )
        )
      )
      .orderBy(desc(chatSessions.startedAt))
      .limit(1);
    return session ?? null;
  }

  private async decryptFriendMessages(
    sessionMap: Map<string, { id: string; userAId: string; userBId: string }>,
    rows: Array<typeof messages.$inferSelect>
  ): Promise<FriendMessageDto[]> {
    return Promise.all(
      rows.map(async (message) => {
        const session = sessionMap.get(message.sessionId);
        const receiverId = session
          ? message.senderId === session.userAId
            ? session.userBId
            : session.userAId
          : '';
        return {
          id: message.id,
          sessionId: message.sessionId,
          senderId: message.senderId,
          receiverId,
          messageType: message.messageType as MessageType,
          content: await this.cryptoService.decrypt({
            encryptedDek: message.encryptedDek,
            ciphertext: message.ciphertext,
            iv: message.iv,
            authTag: message.authTag,
          }),
          metadata: message.metadata,
          isAdultContent: message.isAdultContent,
          sentAt: message.acceptedAt.toISOString(),
          expiresAt: message.expiresAt.toISOString(),
        };
      })
    );
  }

  /**
   * Fetches one chronological page of non-expired friend messages using keyset
   * pagination (`before` cursor) so only the visible slice is loaded and decrypted.
   */
  async getConversationPage(
    userA: string,
    userB: string,
    options: FriendConversationPaginationOptions = {}
  ): Promise<FriendConversationPage> {
    await this.assertUserActive(userA);
    if (!(await this.isFriend(userA, userB))) {
      throw ApiError.forbidden('Chỉ bạn bè mới có thể xem cuộc trò chuyện này.');
    }

    const limit = this.normalizeConversationLimit(options.limit);
    const cursor = options.before ? this.decodeConversationCursor(options.before) : null;
    const now = new Date();

    const sharedSessions = await db
      .select({ id: chatSessions.id, userAId: chatSessions.userAId, userBId: chatSessions.userBId })
      .from(chatSessions)
      .where(
        or(
          and(eq(chatSessions.userAId, userA), eq(chatSessions.userBId, userB)),
          and(eq(chatSessions.userAId, userB), eq(chatSessions.userBId, userA))
        )
      );

    if (sharedSessions.length === 0) {
      return { messages: [], nextCursor: null, hasMore: false };
    }

    const sessionIds = sharedSessions.map((s) => s.id);
    const sessionMap = new Map(sharedSessions.map((s) => [s.id, s]));

    const cursorCondition = cursor
      ? or(
          lt(messages.acceptedAt, cursor.acceptedAt),
          and(eq(messages.acceptedAt, cursor.acceptedAt), lt(messages.id, cursor.id))
        )
      : undefined;

    const descRows = await db
      .select()
      .from(messages)
      .where(
        cursorCondition
          ? and(inArray(messages.sessionId, sessionIds), gt(messages.expiresAt, now), cursorCondition)
          : and(inArray(messages.sessionId, sessionIds), gt(messages.expiresAt, now))
      )
      .orderBy(desc(messages.acceptedAt), desc(messages.id))
      .limit(limit + 1);

    const hasMore = descRows.length > limit;
    const pageAsc = descRows.slice(0, limit).reverse();
    const oldestRow = pageAsc[0];
    const nextCursor = hasMore && oldestRow
      ? this.encodeConversationCursor(oldestRow.acceptedAt, oldestRow.id)
      : null;

    return {
      messages: await this.decryptFriendMessages(sessionMap, pageAsc),
      nextCursor,
      hasMore,
    };
  }

  async getConversation(userA: string, userB: string): Promise<FriendMessageDto[]> {
    await this.assertUserActive(userA);
    if (!(await this.isFriend(userA, userB))) {
      throw ApiError.forbidden('Chỉ bạn bè mới có thể xem cuộc trò chuyện này.');
    }

    const now = new Date();
    const sharedSessions = await db
      .select({ id: chatSessions.id, userAId: chatSessions.userAId, userBId: chatSessions.userBId })
      .from(chatSessions)
      .where(
        or(
          and(eq(chatSessions.userAId, userA), eq(chatSessions.userBId, userB)),
          and(eq(chatSessions.userAId, userB), eq(chatSessions.userBId, userA))
        )
      );
    if (sharedSessions.length === 0) return [];

    const sessionIds = sharedSessions.map((s) => s.id);
    const sessionMap = new Map(sharedSessions.map((s) => [s.id, s]));

    const rows = await db
      .select()
      .from(messages)
      .where(and(inArray(messages.sessionId, sessionIds), gt(messages.expiresAt, now)))
      .orderBy(messages.acceptedAt, messages.id);

    return this.decryptFriendMessages(sessionMap, rows);
  }
}

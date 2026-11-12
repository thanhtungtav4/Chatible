import { Server, Socket } from 'socket.io';
import { SocketEvents } from '@chatible/shared';
import type { ChatState, JoinQueuePayload, SendMessageDto } from '@chatible/shared';
import { MatchingEngine } from '../matching/matching.service.js';
import type { MatchResult, QueuedUser } from '../matching/matching.service.js';
import { RedisSessionCoordinator } from '../matching/session.coordinator.js';
import type { CoordinatedSession, SessionNotification } from '../matching/session.coordinator.js';
import { EnvelopeCryptoService } from '../crypto/envelope.service.js';
import { db } from '../database/index.js';
import { chatSessions } from '../database/schema/sessions.js';
import { messages } from '../database/schema/messages.js';
import { mediaAssets } from '../database/schema/media.js';
import { and, eq } from 'drizzle-orm';
import type Redis from 'ioredis';
import {
  parseCookieHeader,
  SESSION_COOKIE_NAME,
  verifyUserSessionToken,
} from '../auth/session-auth.util.js';
import { DistributedRateLimiter } from '../auth/rate-limiter.js';
import { users, profiles } from '../database/schema/users.js';
import { FriendsService } from '../friends/friends.service.js';
import { SafetyService } from '../safety/safety.service.js';
import { MediaService } from '../media/media.service.js';
import crypto from 'node:crypto';
interface ActiveSession {
  sessionId: string;
  userAId: string;
  userASocketId: string;
  userBId: string;
  userBSocketId: string;
  state: ChatState;
  reconnectTimeout?: NodeJS.Timeout;
}
interface AuthenticatedUser {
  userId: string;
  nickname: string;
  gender: QueuedUser['gender'];
  age: number;
  email: string;
}

interface AuthenticatedSocket extends Socket {
  authUser?: AuthenticatedUser;
}

interface SocketAcknowledgement {
  success: boolean;
  error?: string;
  state?: string;
  messageId?: string;
  sentAt?: string;
  requestId?: string;
  message?: string;
  status?: string;
}

type SocketAck = (response: SocketAcknowledgement) => void;

export class ChatGateway {
  private activeSessions: Map<string, ActiveSession> = new Map(); // sessionId -> Session
  private socketToUser: Map<string, string> = new Map();          // socketId -> userId
  private readonly messageLimiter = new DistributedRateLimiter(5, 2000, 'rl:ws:msg');
  private readonly matchingLimiter = new DistributedRateLimiter(12, 60_000, 'rl:ws:match');
  private pendingDisconnects = new Set<Promise<void>>();
  private pendingGroupEmits = new Set<Promise<void>>();
  private failedGroupDeliveries: Array<{ roomId: string; payload: unknown; attempts: number }> = [];
  private groupRetryTimer?: NodeJS.Timeout;
  private isClosing = false;
  private groupDeliveryMetrics = {
    delivered: 0,
    blockedFiltered: 0,
    failClosedAborts: 0,
    retriesSucceeded: 0,
  };

  setRedis(redis: Redis): void {
    this.messageLimiter.setRedis(redis);
    this.matchingLimiter.setRedis(redis);
  }

  getGroupDeliveryMetrics() {
    return {
      ...this.groupDeliveryMetrics,
      pendingRetryCount: this.failedGroupDeliveries.length,
    };
  }

  emitFriendMessage(toUserId: string, payload: unknown): void {
    this.io.to(this.userRoom(toUserId)).emit(SocketEvents.FRIEND_MESSAGE_RECEIVE, payload);
  }

  private async deliverGroupMessage(roomId: string, payload: unknown, fromRetry = false): Promise<boolean> {
    const obj = (payload && typeof payload === 'object' ? payload : {}) as {
      id?: string;
      senderId?: string;
      isAdmin?: boolean;
      [k: string]: unknown;
    };
    const { senderId, ...publicPayload } = obj;

    try {
      const roomSockets = await this.io.in(`group:${roomId}`).fetchSockets();
      const recipientIds = new Set<string>();
      for (const s of roomSockets) {
        const recipientUserId =
          (s.data as { userId?: string } | undefined)?.userId || this.socketToUser.get(s.id);
        if (recipientUserId && senderId && recipientUserId !== senderId) {
          recipientIds.add(recipientUserId);
        }
      }

      const blockedByRecipient = new Map<string, boolean>();
      if (senderId) {
        await Promise.all(
          [...recipientIds].map(async (recipientUserId) => {
            const blocked = await this.safetyService.isBlocked(recipientUserId, senderId);
            blockedByRecipient.set(recipientUserId, blocked);
          })
        );
      }

      for (const s of roomSockets) {
        const recipientUserId =
          (s.data as { userId?: string } | undefined)?.userId || this.socketToUser.get(s.id);
        if (!recipientUserId) {
          continue;
        }
        if (senderId && recipientUserId !== senderId && blockedByRecipient.get(recipientUserId)) {
          this.groupDeliveryMetrics.blockedFiltered += 1;
          continue;
        }
        s.emit(SocketEvents.GROUP_MESSAGE_RECEIVE, {
          ...publicPayload,
          isSelf: Boolean(senderId && recipientUserId === senderId),
          canReport: Boolean(senderId && recipientUserId !== senderId && !obj.isAdmin),
        });
        this.groupDeliveryMetrics.delivered += 1;
      }

      if (fromRetry) {
        this.groupDeliveryMetrics.retriesSucceeded += 1;
      }
      return true;
    } catch (error) {
      // Fail-closed: NEVER fall back to broadcasting unchecked room messages when Redis/DB block lookup fails.
      this.groupDeliveryMetrics.failClosedAborts += 1;
      console.error('[ChatGateway][Metric] group_emit_fail_closed', {
        roomId,
        messageId: obj.id ?? null,
        failClosedAborts: this.groupDeliveryMetrics.failClosedAborts,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!fromRetry && this.failedGroupDeliveries.length < 500) {
        this.failedGroupDeliveries.push({ roomId, payload, attempts: 1 });
      }
      return false;
    }
  }

  emitGroupMessage(roomId: string, payload: unknown): void {
    if (this.isClosing) return;
    if (!this.groupRetryTimer) {
      this.groupRetryTimer = setInterval(() => {
        void this.retryFailedGroupDeliveries();
      }, 5_000);
      this.groupRetryTimer.unref();
    }
    const task = this.deliverGroupMessage(roomId, payload).then(() => undefined);
    this.pendingGroupEmits.add(task);
    void task.finally(() => {
      this.pendingGroupEmits.delete(task);
    });
  }

  async retryFailedGroupDeliveries(): Promise<number> {
    if (this.isClosing || this.failedGroupDeliveries.length === 0) return 0;
    const batch = this.failedGroupDeliveries.splice(0, 50);
    let succeeded = 0;
    for (const item of batch) {
      const ok = await this.deliverGroupMessage(item.roomId, item.payload, true);
      if (ok) {
        succeeded += 1;
      } else if (item.attempts < 5 && this.failedGroupDeliveries.length < 500) {
        this.failedGroupDeliveries.push({ ...item, attempts: item.attempts + 1 });
      }
    }
    return succeeded;
  }

  async close(): Promise<void> {
    this.isClosing = true;
    if (this.groupRetryTimer) {
      clearInterval(this.groupRetryTimer);
      this.groupRetryTimer = undefined;
    }
    this.failedGroupDeliveries = [];
    await Promise.all([...this.pendingDisconnects, ...this.pendingGroupEmits]);
    for (const session of this.activeSessions.values()) {
      if (session.reconnectTimeout) clearTimeout(session.reconnectTimeout);
    }
    this.activeSessions.clear();
    this.socketToUser.clear();
    await this.messageLimiter.reset();
    await this.matchingLimiter.reset();
  }

  constructor(
    private readonly io: Server,
    private readonly matchingEngine: MatchingEngine,
    private readonly sessionCoordinator: RedisSessionCoordinator,
    private readonly cryptoService: EnvelopeCryptoService,
    private readonly friendsService: FriendsService,
    private readonly safetyService: SafetyService,
    private readonly mediaService: MediaService
  ) {}

  async registerHandlers(): Promise<void> {
    await this.sessionCoordinator.subscribe(async (notification) => {
      try {
        await this.handleSessionNotification(notification);
      } catch (error) {
        console.error('[Chat] Could not apply Redis session notification:', error);
      }
    });
    // 1. Mandatory Socket Authentication Guard (Strict HttpOnly Cookie; Enforces 18+ & Revocation)
    this.io.use(async (socket: Socket, next) => {
      try {
        const cookieToken = parseCookieHeader(socket.handshake.headers?.cookie)[SESSION_COOKIE_NAME];
        const token = cookieToken ? String(cookieToken).trim() : '';

        if (!token) {
          return next(new Error('Yêu cầu đăng nhập và xác thực tài khoản 18+ (Cookie required).'));
        }

        const decoded = await verifyUserSessionToken(token);
        const user = await db.query.users.findFirst({
          where: eq(users.id, decoded.sub),
        });

        if (!user || user.status === 'RESTRICTED' || user.status === 'DELETED') {
          return next(new Error('Tài khoản không hợp lệ hoặc đã bị khóa/đình chỉ.'));
        }

        const profile = await db.query.profiles.findFirst({
          where: eq(profiles.userId, user.id),
        });

        if (!profile || profile.calculatedAge < 18) {
          return next(new Error('Người dùng phải từ đủ 18 tuổi trở lên.'));
        }

        (socket as AuthenticatedSocket).authUser = {
          userId: user.id,
          nickname: profile.nickname,
          gender: profile.gender as QueuedUser['gender'],
          age: profile.calculatedAge,
          email: user.email,
        };

        next();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Xác thực socket thất bại';
        next(new Error(msg));
      }
    });

    this.io.on('connection', (socket: Socket) => {
      const authUser = (socket as AuthenticatedSocket).authUser;
      if (!authUser) {
        socket.disconnect();
        return;
      }

      this.socketToUser.set(socket.id, authUser.userId);
      (socket.data as { userId?: string }).userId = authUser.userId;
      const userRoomReady = Promise.resolve(socket.join(this.userRoom(authUser.userId))).catch((error: unknown) => {
        console.error('[Chat] Could not join user room:', error);
        socket.disconnect(true);
      });

      // 1. Join Matching Queue (Verified server identity & distributed rate limit)
      socket.on(SocketEvents.MATCHING_JOIN, async (payload: JoinQueuePayload & { lastPartnerId?: string }) => {
        await userRoomReady;
        if (!(await this.matchingLimiter.check(authUser.userId))) {
          socket.emit(SocketEvents.MATCHING_ERROR, { error: 'Bạn thao tác tìm bạn quá nhanh. Vui lòng thử lại sau ít giây.' });
          return;
        }
        if (await this.hasLiveSession(authUser.userId)) {
          socket.emit(SocketEvents.MATCHING_ERROR, { error: 'Kết thúc phiên chat hiện tại trước khi ghép đôi lại.' });
          return;
        }
        const queuedUser: QueuedUser = {
          userId: authUser.userId,
          socketId: socket.id,
          nickname: authUser.nickname,
          gender: authUser.gender,
          age: authUser.age,
          targetGender: payload?.targetGender || 'ALL',
          ageMin: payload?.ageMin || 18,
          ageMax: payload?.ageMax || 30,
          lastPartnerId: payload?.lastPartnerId,
          enqueuedAt: Date.now(),
        };

        try {
          const match = await this.matchingEngine.enqueue(queuedUser);
          if (match) await this.activateMatch(match);
        } catch (err: unknown) {
          console.error('[Matching] Could not find an eligible partner:', err);
          socket.emit(SocketEvents.MATCHING_ERROR, { error: 'Không thể hoàn tất ghép đôi. Vui lòng thử lại.' });
        }
      });

      // 2. Cancel Matching
      socket.on(SocketEvents.MATCHING_CANCEL, async () => {
        const userId = this.socketToUser.get(socket.id);
        if (userId) await this.matchingEngine.dequeue(userId);
      });

      socket.on(SocketEvents.MATCHING_EXPAND_ACCEPT, async () => {
        await userRoomReady;
        const userId = this.socketToUser.get(socket.id);
        if (!userId) return;
        if (await this.hasLiveSession(userId)) {
          socket.emit(SocketEvents.MATCHING_ERROR, { error: 'Kết thúc phiên chat hiện tại trước khi ghép đôi lại.' });
          return;
        }
        try {
          const match = await this.matchingEngine.expandFilter(userId);
          if (match) await this.activateMatch(match);
        } catch (err: unknown) {
          console.error('[Matching] Could not expand match filters:', err);
          socket.emit(SocketEvents.MATCHING_ERROR, { error: 'Không thể hoàn tất ghép đôi. Vui lòng thử lại.' });
        }
      });

      // 4. Send Message (Envelope Encrypted)
      socket.on(SocketEvents.MESSAGE_SEND, async (data: SendMessageDto, ack?: SocketAck) => {
        const userId = authUser.userId;

        // Content validation & sliding-window rate limit (SEC-03)
        if (!data || typeof data.content !== 'string' || !data.content.trim()) {
          if (ack) ack({ success: false, error: 'Nội dung tin nhắn không được để trống.' });
          return;
        }
        if (data.content.length > 4000) {
          if (ack) ack({ success: false, error: 'Tin nhắn vượt quá độ dài tối đa cho phép (4000 ký tự).' });
          return;
        }

        if (!(await this.messageLimiter.check(userId))) {
          if (ack) ack({ success: false, error: 'Bạn đang gửi tin nhắn quá nhanh. Vui lòng thử lại sau.' });
          return;
        }

        const coordinatedSession = await this.sessionCoordinator.getSessionByUser(userId);
        if (!coordinatedSession) {
          if (ack) ack({ success: false, error: 'Không tìm thấy phiên chat' });
          return;
        }
        if (coordinatedSession.state !== 'CHATTING') {
          if (ack) ack({ success: false, error: 'Cuộc trò chuyện đã kết thúc hoặc đang kết nối lại' });
          return;
        }

        const session = this.cacheSession(coordinatedSession);

        const partnerId = session.userAId === userId ? session.userBId : session.userAId;

        // Block Guard: Do not allow sending messages if either party blocked the other
        if (await this.safetyService.isBlocked(userId, partnerId)) {
          if (ack) ack({ success: false, error: 'Không thể gửi tin nhắn do đối tác đã bị chặn.' });
          return;
        }

        // CHAT-03: Idempotency check by clientMessageId
        const clientMessageId =
          typeof data.clientMessageId === 'string' && data.clientMessageId.trim().length > 0
            ? data.clientMessageId.trim().slice(0, 64)
            : null;
        if (clientMessageId) {
          const [existing] = await db
            .select({ id: messages.id, acceptedAt: messages.acceptedAt })
            .from(messages)
            .where(
              and(
                eq(messages.sessionId, session.sessionId),
                eq(messages.senderId, userId),
                eq(messages.clientMessageId, clientMessageId)
              )
            )
            .limit(1);
          if (existing) {
            if (ack) {
              ack({
                success: true,
                messageId: existing.id,
                sentAt: existing.acceptedAt.toISOString(),
              });
            }
            return;
          }
        }

        // Strict Media Asset Integrity & Consent Guard (MEDIA-04, MEDIA-09, ADULT-03A)
        let metadata = data.metadata;
        let verifiedIsAdult = false;
        if (data.type && data.type !== 'TEXT') {
          let extractedMediaId = '';
          try {
            const parsed = typeof data.content === 'string' ? JSON.parse(data.content) : data.content;
            if (parsed && typeof parsed === 'object') {
              extractedMediaId = String(
                (parsed as { mediaId?: string; media_id?: string }).mediaId ||
                  (parsed as { media_id?: string }).media_id ||
                  ''
              ).trim();
            }
          } catch {
            // Fall through to metadata lookup
          }
          if (!extractedMediaId && metadata && typeof metadata === 'object') {
            extractedMediaId = String((metadata as { mediaId?: string }).mediaId || '').trim();
          }
          if (!extractedMediaId) {
            if (ack) ack({ success: false, error: 'Tin nhắn media bắt buộc gắn với mã mediaId hợp lệ.' });
            return;
          }

          try {
            const verifiedAsset = await this.mediaService.verifyDeliverableMedia({
              mediaId: extractedMediaId,
              sessionId: session.sessionId,
              senderId: userId,
              recipientId: partnerId,
              mediaType: data.type,
              isAdultContent: Boolean(data.isAdultContent),
            });
            verifiedIsAdult = verifiedAsset.isAdult;
            metadata = { ...metadata, mediaId: verifiedAsset.id, isAdult: verifiedAsset.isAdult };
          } catch (mediaErr: unknown) {
            const errMsg = mediaErr instanceof Error ? mediaErr.message : 'Media không hợp lệ hoặc chưa hoàn tất tải lên.';
            if (ack) ack({ success: false, error: errMsg });
            return;
          }
        }

        // Encrypt message content with DEK envelope
        const encrypted = await this.cryptoService.encrypt(data.content);
        const msgId = crypto.randomUUID();
        const now = new Date();

        // 1. Persist message to PostgreSQL with Envelope Encryption FIRST
        try {
          await db.insert(messages).values({
            id: msgId,
            sessionId: session.sessionId,
            senderId: userId,
            clientMessageId,
            messageType: data.type || 'TEXT',
            encryptedDek: encrypted.encryptedDek,
            iv: encrypted.iv,
            authTag: encrypted.authTag,
            ciphertext: encrypted.ciphertext,
            metadata,
            isAdultContent: verifiedIsAdult,
            expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
          });
        } catch (e) {
          console.error('[DB Message Insert Error]:', e);
          // DO NOT forward to partner if saving to DB failed!
          if (ack) ack({ success: false, error: 'Không thể lưu tin nhắn vào cơ sở dữ liệu' });
          return;
        }

        // 2. DB save succeeded -> Forward to partner & ACK to sender
        this.io.to(this.userRoom(partnerId)).emit(SocketEvents.MESSAGE_RECEIVE, {
          id: msgId,
          senderId: userId,
          type: data.type || 'TEXT',
          content: data.content,
          metadata,
          isAdultContent: verifiedIsAdult,
          sentAt: now.toISOString(),
        });

        if (ack) {
          ack({ success: true, messageId: msgId, sentAt: now.toISOString() });
        }
      });

      // 5. Next Chat / End Chat
      socket.on(SocketEvents.CHAT_NEXT, async (_payload?: unknown, ack?: (res: { success: boolean }) => void) => {
        try {
          await this.handleEndChat(socket, 'USER_LEFT');
          ack?.({ success: true });
        } catch (err) {
          console.error('[Chat] Could not end current session before next match:', err);
          ack?.({ success: false });
        }
      });

      socket.on(SocketEvents.CHAT_END, async (_payload?: unknown, ack?: (res: { success: boolean }) => void) => {
        try {
          await this.handleEndChat(socket, 'USER_LEFT');
          ack?.({ success: true });
        } catch (err) {
          console.error('[Chat] Could not end session:', err);
          ack?.({ success: false });
        }
      });

      // A disconnect only starts the shared recovery window for the socket currently
      // attached to the participant; stale multi-device sockets cannot suspend it.
      socket.on('disconnect', () => {
        const pending = this.handleDisconnect(socket, authUser.userId).catch((error: unknown) => {
          console.error('[Chat] Could not mark session reconnecting:', error);
        });
        this.pendingDisconnects.add(pending);
        void pending.finally(() => this.pendingDisconnects.delete(pending));
      });

      socket.on(SocketEvents.SESSION_RESUME, async ({ sessionId }: { sessionId: string }, ack?: SocketAck) => {
        await userRoomReady;
        try {
          const session = typeof sessionId === 'string'
            ? await this.sessionCoordinator.getSessionByUser(authUser.userId)
            : null;
          if (!session || session.sessionId !== sessionId || session.state !== 'RECONNECTING') {
            ack?.({ success: false, error: 'Phiên chat đã kết thúc hoặc không thể khôi phục.' });
            return;
          }

          const restored = await this.sessionCoordinator.updateSocket(sessionId, authUser.userId, socket.id);
          this.socketToUser.set(socket.id, authUser.userId);
          (socket.data as { userId?: string }).userId = authUser.userId;
          const activeSession = this.cacheSession(restored);
          const partnerUserId = activeSession.userAId === authUser.userId
            ? activeSession.userBId
            : activeSession.userAId;
          if (restored.state === 'CHATTING') {
            this.io.to(this.userRoom(partnerUserId)).emit(SocketEvents.CONNECTION_RESTORED);
          }
          ack?.({ success: true, state: restored.state });
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : 'Phiên chat đã kết thúc hoặc không thể khôi phục.';
          ack?.({ success: false, error: message });
        }
      });

      // 8. Friend Request Handlers
      socket.on(SocketEvents.FRIEND_REQUEST_SEND, async ({ targetUserId }: { targetUserId: string }, ack?: SocketAck) => {
        await userRoomReady;
        try {
          const res = await this.friendsService.sendFriendRequest(authUser.userId, targetUserId);
          this.io.to(this.userRoom(targetUserId)).emit(SocketEvents.FRIEND_REQUEST_RECEIVED, {
            requestId: res.requestId,
            fromUserId: authUser.userId,
            fromNickname: authUser.nickname,
            fromGender: authUser.gender,
            fromAge: authUser.age,
          });
          if (ack) ack({ success: true, ...res });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Lỗi kết bạn';
          if (ack) ack({ success: false, error: msg });
        }
      });

      socket.on(SocketEvents.FRIEND_REQUEST_ACCEPT, async ({ requestId }: { requestId: string }, ack?: SocketAck) => {
        try {
          const res = await this.friendsService.acceptFriendRequest(requestId, authUser.userId);
          if (ack) ack({ success: true, ...res });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Lỗi chấp nhận kết bạn';
          if (ack) ack({ success: false, error: msg });
        }
      });

      // 9. Realtime Media Consent / Revocation Relay
      socket.on(SocketEvents.MEDIA_CONSENT_UPDATE, async ({ enabled }: { enabled: boolean }) => {
        const session = await this.sessionCoordinator.getSessionByUser(authUser.userId);
        if (!session || session.state === 'ENDED') return;
        const partnerId = session.userAId === authUser.userId ? session.userBId : session.userAId;
        this.io.to(this.userRoom(partnerId)).emit(SocketEvents.MEDIA_CONSENT_UPDATE, {
          sessionId: session.sessionId,
          enabled: Boolean(enabled),
        });
      });

      socket.on(SocketEvents.MEDIA_ADULT_CONSENT_UPDATE, async ({ enabled }: { enabled: boolean }) => {
        const session = await this.sessionCoordinator.getSessionByUser(authUser.userId);
        if (!session || session.state === 'ENDED') return;
        const partnerId = session.userAId === authUser.userId ? session.userBId : session.userAId;
        this.io.to(this.userRoom(partnerId)).emit(SocketEvents.MEDIA_ADULT_CONSENT_UPDATE, {
          sessionId: session.sessionId,
          enabled: Boolean(enabled),
        });
      });

      socket.on(SocketEvents.MEDIA_REVOKED, async ({ mediaId }: { mediaId: string }) => {
        if (!mediaId) return;
        const session = await this.sessionCoordinator.getSessionByUser(authUser.userId);
        if (!session) return;
        const partnerId = session.userAId === authUser.userId ? session.userBId : session.userAId;
        this.io.to(this.userRoom(partnerId)).emit(SocketEvents.MEDIA_REVOKED, {
          sessionId: session.sessionId,
          mediaId,
        });
      });

      // 10. Group / Channel subscription
      socket.on(SocketEvents.GROUP_JOIN, async ({ roomId }: { roomId: string }, ack?: SocketAck) => {
        if (!roomId) return;
        if (this.groupAccessChecker && !(await this.groupAccessChecker(authUser.userId, roomId))) {
          ack?.({ success: false, error: 'Bạn chưa mở khóa hoặc tham gia nhóm này.' });
          return;
        }
        await socket.join(`group:${roomId}`);
        ack?.({ success: true });
      });

      socket.on(SocketEvents.GROUP_LEAVE, async ({ roomId }: { roomId: string }) => {
        if (!roomId) return;
        await socket.leave(`group:${roomId}`);
      });
    });
  }

  private groupAccessChecker?: (userId: string, roomId: string) => Promise<boolean>;

  setGroupAccessChecker(checker: (userId: string, roomId: string) => Promise<boolean>): void {
    this.groupAccessChecker = checker;
  }

  private async activateMatch(match: MatchResult): Promise<void> {
    if (!this.sessionCoordinator.isOwner(match)) {
      throw new Error('Only the match owner may persist a new chat session.');
    }

    try {
      await db.insert(chatSessions).values({
        id: match.sessionId,
        sessionType: 'RANDOM',
        userAId: match.userA.userId,
        userBId: match.userB.userId,
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });
      await this.sessionCoordinator.ensureSession(match);
      await this.sessionCoordinator.publishMatch(match);
    } catch (error: unknown) {
      console.error('[Chat] Could not persist or publish matched session:', error);
      await this.sessionCoordinator.setState(match.sessionId, 'ENDED', 'MATCH_FAILED').catch(() => undefined);
      await db.delete(chatSessions).where(eq(chatSessions.id, match.sessionId)).catch(() => undefined);

      const matchedUsers = [match.userA, match.userB];
      const waitingUsers = await Promise.all(matchedUsers.map(async (user) => {
        try {
          return (await this.io.in(user.socketId).fetchSockets()).length > 0 ? user : null;
        } catch {
          return this.io.sockets.sockets.has(user.socketId) ? user : null;
        }
      }));
      const connectedUsers = waitingUsers.filter((user): user is QueuedUser => user !== null);
      await this.matchingEngine.restoreUsers(connectedUsers);
      for (const user of matchedUsers) {
        this.io.to(user.socketId).emit(SocketEvents.MATCHING_ERROR, {
          error: 'Chưa thể lưu phiên chat; vui lòng thử ghép đôi lại.',
        });
      }
    }
  }

  private async handleSessionNotification(notification: SessionNotification): Promise<void> {
    if (notification.type === 'MATCH_CREATED') {
      await this.sessionCoordinator.ensureSession(notification.match);
      this.cacheSession({
        sessionId: notification.match.sessionId,
        userAId: notification.match.userA.userId,
        userASocketId: notification.match.userA.socketId,
        userBId: notification.match.userB.userId,
        userBSocketId: notification.match.userB.socketId,
        ownerInstanceId: notification.match.ownerInstanceId,
        state: 'CHATTING',
      });
      this.io.local.to(this.userRoom(notification.match.userA.userId)).emit(SocketEvents.MATCHING_FOUND, {
        sessionId: notification.match.sessionId,
        partner: {
          id: notification.match.userB.userId,
          nickname: notification.match.userB.nickname,
          gender: notification.match.userB.gender,
          age: notification.match.userB.age,
        },
        matchedAt: notification.match.matchedAt,
      });
      this.io.local.to(this.userRoom(notification.match.userB.userId)).emit(SocketEvents.MATCHING_FOUND, {
        sessionId: notification.match.sessionId,
        partner: {
          id: notification.match.userA.userId,
          nickname: notification.match.userA.nickname,
          gender: notification.match.userA.gender,
          age: notification.match.userA.age,
        },
        matchedAt: notification.match.matchedAt,
      });
      return;
    }

    if (notification.session.state === 'ENDED') {
      await this.persistEndedSession(notification.session);
      return;
    }
    this.cacheSession(notification.session);
  }

  async revokeUser(userId: string): Promise<void> {
    try {
      await this.messageLimiter.reset(userId);
      await this.matchingEngine.dequeue(userId);
      const session = await this.sessionCoordinator.getSessionByUser(userId);
      if (session && session.state !== 'ENDED') {
        await this.endActiveSession(session.sessionId, 'USER_RESTRICTED');
      }
    } finally {
      this.io.in(this.userRoom(userId)).disconnectSockets(true);
    }
  }

  private async handleEndChat(socket: Socket, reason: string): Promise<void> {
    const userId = this.socketToUser.get(socket.id);
    if (!userId) return;
    const session = await this.sessionCoordinator.getSessionByUser(userId);
    if (!session || session.state === 'ENDED') return;
    await this.endActiveSession(session.sessionId, reason);
  }

  private async handleDisconnect(socket: Socket, userId: string): Promise<void> {
    if (this.socketToUser.get(socket.id) !== userId) return;
    this.socketToUser.delete(socket.id);
    await this.matchingEngine.dequeue(userId);
    const session = await this.sessionCoordinator.markDisconnected(userId, socket.id);
    if (!session) return;

    const activeSession = this.cacheSession(session);
    const partnerSocketId = activeSession.userAId === userId
      ? activeSession.userBSocketId
      : activeSession.userASocketId;
    this.io.to(partnerSocketId).emit(SocketEvents.CONNECTION_LOST, { timeoutSec: 30 });
  }

  private async endActiveSession(sessionId: string, reason: string): Promise<void> {
    const session = await this.sessionCoordinator.setState(sessionId, 'ENDED', reason);
    await this.persistEndedSession(session, false);
  }

  private async persistEndedSession(session: CoordinatedSession, deliver = true): Promise<void> {
    const endedAt = new Date();
    const expiresAt = new Date(endedAt.getTime() + 7 * 24 * 60 * 60 * 1000);
    try {
      await db.update(chatSessions)
        .set({
          status: 'ENDED',
          endReason: session.endReason || 'USER_LEFT',
          endedAt,
          expiresAt,
        })
        .where(and(eq(chatSessions.id, session.sessionId), eq(chatSessions.status, 'ACTIVE')));

      await db.update(messages)
        .set({ expiresAt })
        .where(eq(messages.sessionId, session.sessionId));

      await db.update(mediaAssets)
        .set({ expiresAt })
        .where(eq(mediaAssets.sessionId, session.sessionId));
    } finally {
      if (deliver) {
        const reason = session.endReason || 'USER_LEFT';
        this.io.local.to(this.userRoom(session.userAId)).emit(SocketEvents.CHAT_ENDED, { reason });
        this.io.local.to(this.userRoom(session.userBId)).emit(SocketEvents.CHAT_ENDED, { reason });
      }
      this.cleanupSession(session.sessionId);
    }
  }

  private async endExpiredReconnect(sessionId: string): Promise<void> {
    await this.sessionCoordinator.endIfReconnectExpired(sessionId);
  }

  private async hasLiveSession(userId: string): Promise<boolean> {
    const session = await this.sessionCoordinator.getSessionByUser(userId);
    if (!session || session.state === 'ENDED') return false;
    this.cacheSession(session);
    return true;
  }

  private cacheSession(shared: CoordinatedSession): ActiveSession {
    const current = this.activeSessions.get(shared.sessionId);
    const session: ActiveSession = {
      sessionId: shared.sessionId,
      userAId: shared.userAId,
      userASocketId: shared.userASocketId,
      userBId: shared.userBId,
      userBSocketId: shared.userBSocketId,
      state: shared.state as ChatState,
      reconnectTimeout: current?.reconnectTimeout,
    };
    this.activeSessions.set(shared.sessionId, session);
    if (shared.state === 'RECONNECTING') {
      if (!session.reconnectTimeout) {
        const timeoutMs = Math.max(0, (shared.reconnectUntil ?? Date.now()) - Date.now());
        session.reconnectTimeout = setTimeout(() => {
          void this.endExpiredReconnect(shared.sessionId).catch((error: unknown) => {
            console.error('[Chat] Could not expire reconnecting session:', error);
          });
        }, timeoutMs);
      }
    } else if (session.reconnectTimeout) {
      clearTimeout(session.reconnectTimeout);
      session.reconnectTimeout = undefined;
    }
    return session;
  }

  private userRoom(userId: string): string {
    return `user:${userId}`;
  }

  private cleanupSession(sessionId: string, session?: ActiveSession): void {
    const activeSession = session ?? this.activeSessions.get(sessionId);
    if (activeSession?.reconnectTimeout) clearTimeout(activeSession.reconnectTimeout);
    this.activeSessions.delete(sessionId);
  }
}


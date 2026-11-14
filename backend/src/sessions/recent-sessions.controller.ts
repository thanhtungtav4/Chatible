import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../database/index.js';
import { chatSessions } from '../database/schema/sessions.js';
import { profiles } from '../database/schema/users.js';
import { messages } from '../database/schema/messages.js';
import { friendships } from '../database/schema/friends.js';
import { eq, or, and, desc, sql, gt, isNotNull, inArray } from 'drizzle-orm';
import { EnvelopeCryptoService } from '../crypto/envelope.service.js';
import { verifyVaultUnlocked } from '../auth/session-auth.util.js';
import { ApiError, sendApiError } from '../http/api-error.js';
import { authenticateRequest } from '../http/route-auth.js';
import type { RedisSessionCoordinator } from '../matching/session.coordinator.js';

export class RecentSessionsController {
  constructor(
    private readonly cryptoService?: EnvelopeCryptoService,
    private readonly sessionCoordinator?: RedisSessionCoordinator
  ) {}

  private async assertVaultUnlockedIfEnabled(req: FastifyRequest, userId: string): Promise<void> {
    const profile = await db.query.profiles.findFirst({
      where: eq(profiles.userId, userId),
      columns: { stealthEnabled: true },
    });
    if (profile?.stealthEnabled && !(await verifyVaultUnlocked(req, userId))) {
      throw ApiError.vaultLocked();
    }
  }

  registerRoutes(app: FastifyInstance) {
    // GET /api/v1/sessions/active (Checks whether user has an active/reconnecting session in Redis)
    app.get('/api/v1/sessions/active', async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = await authenticateRequest(req, 'active_only');
        if (!this.sessionCoordinator) {
          return reply.status(200).send({ activeSession: null });
        }
        const session = await this.sessionCoordinator.getSessionByUser(userId);
        if (!session || session.state === 'ENDED') {
          return reply.status(200).send({ activeSession: null });
        }

        const partnerId = session.userAId === userId ? session.userBId : session.userAId;
        const [partnerProfile] = await db
          .select({
            userId: profiles.userId,
            nickname: profiles.nickname,
            gender: profiles.gender,
            calculatedAge: profiles.calculatedAge,
          })
          .from(profiles)
          .where(eq(profiles.userId, partnerId))
          .limit(1);

        const rawMessages = await db
          .select()
          .from(messages)
          .where(eq(messages.sessionId, session.sessionId))
          .orderBy(messages.acceptedAt);

        let decryptedMessages: Array<{ id: string; sender: 'me' | 'partner'; text: string; time: string; media?: unknown }> = [];
        if (this.cryptoService && rawMessages.length > 0) {
          decryptedMessages = await Promise.all(
            rawMessages.map(async (m) => {
              let text = '';
              try {
                text = await this.cryptoService!.decrypt({
                  ciphertext: m.ciphertext,
                  encryptedDek: m.encryptedDek,
                  iv: m.iv,
                  authTag: m.authTag,
                });
              } catch {
                text = '[Không thể giải mã tin nhắn]';
              }
              return {
                id: m.id,
                sender: (m.senderId === userId ? 'me' : 'partner') as 'me' | 'partner',
                text,
                time: new Date(m.acceptedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
              };
            })
          );
        }

        return reply.status(200).send({
          activeSession: {
            sessionId: session.sessionId,
            state: session.state,
            partner: partnerProfile
              ? {
                  id: partnerProfile.userId,
                  nickname: partnerProfile.nickname,
                  gender: partnerProfile.gender,
                  age: partnerProfile.calculatedAge,
                }
              : {
                  id: partnerId,
                  nickname: 'Người lạ',
                  gender: 'OTHER',
                  age: 20,
                },
            messages: decryptedMessages,
          },
        });
      } catch (err: unknown) {
        return sendApiError(reply, err, {
          fallbackStatus: 500,
          fallbackMessage: 'Lỗi kiểm tra phiên chat hoạt động',
        });
      }
    });
    // GET /api/v1/sessions/recent (Real 7-day sessions from PostgreSQL; enforces Stealth Vault PIN lock on backend)
    app.get('/api/v1/sessions/recent', async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = await authenticateRequest(req, 'active_only');
        await this.assertVaultUnlockedIfEnabled(req, userId);

        const now = new Date();
        // Return only ended random sessions still within the seven-day retention window.
        const rows = await db
          .select()
          .from(chatSessions)
          .where(
            and(
              or(eq(chatSessions.userAId, userId), eq(chatSessions.userBId, userId)),
              eq(chatSessions.sessionType, 'RANDOM'),
              eq(chatSessions.status, 'ENDED'),
              isNotNull(chatSessions.endedAt),
              gt(chatSessions.expiresAt, now)
            )
          )
          .orderBy(desc(chatSessions.startedAt))
          .limit(20);

        if (rows.length === 0) {
          return reply.status(200).send({ sessions: [] });
        }

        const partnerIds = Array.from(
          new Set(rows.map((s) => (s.userAId === userId ? s.userBId : s.userAId)))
        );
        const sessionIds = rows.map((s) => s.id);

        const [partnerProfiles, messageCounts, activeFriendships] = await Promise.all([
          partnerIds.length > 0
            ? db
                .select({
                  userId: profiles.userId,
                  nickname: profiles.nickname,
                  gender: profiles.gender,
                  calculatedAge: profiles.calculatedAge,
                })
                .from(profiles)
                .where(inArray(profiles.userId, partnerIds))
            : Promise.resolve([]),
          sessionIds.length > 0
            ? db
                .select({
                  sessionId: messages.sessionId,
                  count: sql<number>`count(*)::int`,
                })
                .from(messages)
                .where(inArray(messages.sessionId, sessionIds))
                .groupBy(messages.sessionId)
            : Promise.resolve([]),
          partnerIds.length > 0
            ? db
                .select({
                  user1Id: friendships.user1Id,
                  user2Id: friendships.user2Id,
                })
                .from(friendships)
                .where(
                  or(
                    and(eq(friendships.user1Id, userId), inArray(friendships.user2Id, partnerIds)),
                    and(eq(friendships.user2Id, userId), inArray(friendships.user1Id, partnerIds))
                  )
                )
            : Promise.resolve([]),
        ]);

        const friendPartnerIdSet = new Set(
          activeFriendships.map((f) => (f.user1Id === userId ? f.user2Id : f.user1Id))
        );

        const profileMap = new Map(partnerProfiles.map((p) => [p.userId, p]));
        const countMap = new Map(messageCounts.map((c) => [c.sessionId, Number(c.count)]));

        const recentList = rows.map((s) => {
          const partnerId = s.userAId === userId ? s.userBId : s.userAId;
          const partnerProf = profileMap.get(partnerId);
          const remainingDays = Math.max(
            1,
            Math.ceil((new Date(s.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000))
          );

          return {
            partnerId,
            id: s.id,
            partnerName: partnerProf?.nickname || 'Người lạ',
            partnerGender: partnerProf?.gender === 'FEMALE' ? 'Nữ' : 'Nam',
            partnerAge: partnerProf?.calculatedAge || 20,
            messagesCount: countMap.get(s.id) ?? 0,
            endedAt: s.endedAt || s.startedAt,
            expiresAt: s.expiresAt,
            remainingDays,
            isFriend: friendPartnerIdSet.has(partnerId),
          };
        });

        return reply.status(200).send({ sessions: recentList });
      } catch (err: unknown) {
        return sendApiError(reply, err, {
          fallbackStatus: 500,
          fallbackCode: 'INTERNAL_ERROR',
          fallbackMessage: 'Lỗi lấy phiên gần đây',
        });
      }
    });

    // GET /api/v1/sessions/:sessionId/messages (Transcript of recent session within 7 days; enforces Stealth Vault PIN lock)
    app.get(
      '/api/v1/sessions/:sessionId/messages',
      async (req: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) => {
        try {
          const userId = await authenticateRequest(req, 'active_only');
          await this.assertVaultUnlockedIfEnabled(req, userId);

          const { sessionId } = req.params;
          const now = new Date();

          const [session] = await db
            .select()
            .from(chatSessions)
            .where(eq(chatSessions.id, sessionId))
            .limit(1);

          if (!session) {
            throw ApiError.notFound('Không tìm thấy phiên trò chuyện.');
          }

          if (session.userAId !== userId && session.userBId !== userId) {
            throw ApiError.forbidden('Bạn không phải thành viên của phiên chat này.');
          }

          if (session.expiresAt && session.expiresAt <= now) {
            throw ApiError.gone('Phiên trò chuyện đã hết hạn lưu trữ (7 ngày).');
          }

          const sessionMessages = await db
            .select()
            .from(messages)
            .where(eq(messages.sessionId, sessionId))
            .orderBy(messages.acceptedAt);

          if (!this.cryptoService) {
            return reply.status(200).send({
              messages: sessionMessages.map((m) => ({
                id: m.id,
                senderId: m.senderId,
                messageType: m.messageType,
                metadata: m.metadata,
                isAdultContent: m.isAdultContent,
                sentAt: m.acceptedAt.toISOString(),
              })),
            });
          }

          const decryptedMessages = await Promise.all(
            sessionMessages.map(async (m) => {
              try {
                const content = await this.cryptoService!.decrypt({
                  encryptedDek: m.encryptedDek,
                  iv: m.iv,
                  authTag: m.authTag,
                  ciphertext: m.ciphertext,
                });
                return {
                  id: m.id,
                  senderId: m.senderId,
                  messageType: m.messageType,
                  content,
                  metadata: m.metadata,
                  isAdultContent: m.isAdultContent,
                  sentAt: m.acceptedAt.toISOString(),
                };
              } catch {
                return {
                  id: m.id,
                  senderId: m.senderId,
                  messageType: m.messageType,
                  content: '[Không thể giải mã]',
                  metadata: m.metadata,
                  isAdultContent: m.isAdultContent,
                  sentAt: m.acceptedAt.toISOString(),
                };
              }
            })
          );

          return reply.status(200).send({ messages: decryptedMessages });
        } catch (err: unknown) {
          return sendApiError(reply, err, {
            fallbackStatus: 500,
            fallbackCode: 'INTERNAL_ERROR',
            fallbackMessage: 'Lỗi lấy tin nhắn phiên gần đây',
          });
        }
      }
    );
  }
}

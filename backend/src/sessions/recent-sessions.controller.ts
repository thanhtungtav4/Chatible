import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../database/index.js';
import { chatSessions } from '../database/schema/sessions.js';
import { profiles, users } from '../database/schema/users.js';
import { messages } from '../database/schema/messages.js';
import { eq, or, and, desc, sql, gt, isNotNull } from 'drizzle-orm';
import { EnvelopeCryptoService } from '../crypto/envelope.service.js';
import { getAuthenticatedClaims, verifyVaultUnlocked } from '../auth/session-auth.util.js';

export class RecentSessionsController {
  constructor(private readonly cryptoService?: EnvelopeCryptoService) {}

  private async getAuthUserId(req: FastifyRequest): Promise<string> {
    const payload = await getAuthenticatedClaims(req);
    const [user] = await db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, payload.sub))
      .limit(1);
    if (!user || user.status === 'RESTRICTED' || user.status === 'DELETED') {
      throw new Error('Tài khoản đã bị khóa hoặc đình chỉ do vi phạm chính sách cộng đồng.');
    }
    return payload.sub;
  }

  private async assertVaultUnlockedIfEnabled(req: FastifyRequest, userId: string): Promise<boolean> {
    const profile = await db.query.profiles.findFirst({
      where: eq(profiles.userId, userId),
      columns: { stealthEnabled: true },
    });
    if (!profile?.stealthEnabled) return true;
    return verifyVaultUnlocked(req, userId);
  }

  registerRoutes(app: FastifyInstance) {
    // GET /api/v1/sessions/recent (Real 7-day sessions from PostgreSQL; enforces Stealth Vault PIN lock on backend)
    app.get('/api/v1/sessions/recent', async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = await this.getAuthUserId(req);
        if (!(await this.assertVaultUnlockedIfEnabled(req, userId))) {
          return reply.status(423).send({
            error: 'Kho riêng tư đang khóa. Vui lòng nhập mã PIN để mở khóa.',
            vaultLocked: true,
          });
        }

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

        const recentList = await Promise.all(
          rows.map(async (s) => {
            const partnerId = s.userAId === userId ? s.userBId : s.userAId;
            const partnerProf = await db.query.profiles.findFirst({
              where: eq(profiles.userId, partnerId),
            });

            const [msgCount] = await db
              .select({ count: sql<number>`count(*)` })
              .from(messages)
              .where(eq(messages.sessionId, s.id));

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
              messagesCount: Number(msgCount?.count || 0),
              endedAt: s.endedAt || s.startedAt,
              expiresAt: s.expiresAt,
              remainingDays,
            };
          })
        );

        return reply.status(200).send({ sessions: recentList });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Lỗi lấy phiên gần đây';
        return reply.status(401).send({ error: msg });
      }
    });

    // GET /api/v1/sessions/:sessionId/messages (Transcript of recent session within 7 days; enforces Stealth Vault PIN lock)
    app.get(
      '/api/v1/sessions/:sessionId/messages',
      async (req: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) => {
        let userId: string;
        try {
          userId = await this.getAuthUserId(req);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Yêu cầu xác thực tài khoản.';
          return reply.status(401).send({ error: msg });
        }

        try {
          if (!(await this.assertVaultUnlockedIfEnabled(req, userId))) {
            return reply.status(423).send({
              error: 'Kho riêng tư đang khóa. Vui lòng nhập mã PIN để mở khóa.',
              vaultLocked: true,
            });
          }

          const { sessionId } = req.params;
          const now = new Date();

          const [session] = await db
            .select()
            .from(chatSessions)
            .where(eq(chatSessions.id, sessionId))
            .limit(1);

          if (!session) {
            return reply.status(404).send({ error: 'Không tìm thấy phiên trò chuyện.' });
          }

          if (session.userAId !== userId && session.userBId !== userId) {
            return reply.status(403).send({ error: 'Bạn không phải thành viên của phiên chat này.' });
          }

          if (session.expiresAt && session.expiresAt <= now) {
            return reply.status(410).send({ error: 'Phiên trò chuyện đã hết hạn lưu trữ (7 ngày).' });
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
          const msg = err instanceof Error ? err.message : 'Lỗi lấy tin nhắn phiên gần đây';
          return reply.status(400).send({ error: msg });
        }
      }
    );
  }
}

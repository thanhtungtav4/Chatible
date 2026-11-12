import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type Redis from 'ioredis';
import { SafetyService, ReportReason } from './safety.service.js';
import { db } from '../database/index.js';
import { users } from '../database/schema/users.js';
import { eq } from 'drizzle-orm';
import { DistributedRateLimiter } from '../auth/rate-limiter.js';
import { getAuthenticatedClaims } from '../auth/session-auth.util.js';

export class SafetyController {
  private readonly reportLimiter = new DistributedRateLimiter(5, 60_000, 'rl:safety:report'); // 5 reports / min
  private readonly appealLimiter = new DistributedRateLimiter(3, 60_000, 'rl:safety:appeal'); // 3 appeals / min

  constructor(private readonly safetyService: SafetyService) {}

  setRedis(redis: Redis): void {
    this.reportLimiter.setRedis(redis);
    this.appealLimiter.setRedis(redis);
  }

  private async getAuthUserId(req: FastifyRequest, requireActive = true): Promise<string> {
    const payload = await getAuthenticatedClaims(req);
    const [user] = await db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, payload.sub))
      .limit(1);
    if (!user) {
      throw new Error('Tài khoản không tồn tại.');
    }
    if (requireActive && (user.status === 'RESTRICTED' || user.status === 'DELETED')) {
      throw new Error('Tài khoản đã bị khóa hoặc đình chỉ do vi phạm chính sách cộng đồng.');
    }
    return payload.sub;
  }

  registerRoutes(app: FastifyInstance) {
    // POST /api/v1/blocks
    app.post('/api/v1/blocks', async (req: FastifyRequest<{ Body: { targetUserId: string } }>, reply: FastifyReply) => {
      try {
        const userId = await this.getAuthUserId(req, true);
        const res = await this.safetyService.blockUser(userId, req.body.targetUserId);
        return reply.status(200).send(res);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Chặn người dùng thất bại';
        return reply.status(400).send({ error: msg });
      }
    });

    // GET /api/v1/blocks
    app.get('/api/v1/blocks', async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = await this.getAuthUserId(req, true);
        const blockedUsers = await this.safetyService.listBlockedUsers(userId);
        return reply.status(200).send({ blockedUsers });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Lấy danh sách chặn thất bại';
        return reply.status(400).send({ error: msg });
      }
    });

    // DELETE /api/v1/blocks/:targetUserId
    app.delete(
      '/api/v1/blocks/:targetUserId',
      async (req: FastifyRequest<{ Params: { targetUserId: string } }>, reply: FastifyReply) => {
        try {
          const userId = await this.getAuthUserId(req, true);
          const res = await this.safetyService.unblockUser(userId, req.params.targetUserId);
          return reply.status(200).send(res);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Bỏ chặn người dùng thất bại';
          return reply.status(400).send({ error: msg });
        }
      }
    );

    // POST /api/v1/appeals (Allow RESTRICTED users to appeal)
    app.post(
      '/api/v1/appeals',
      async (req: FastifyRequest<{ Body: { reason: string } }>, reply: FastifyReply) => {
        try {
          const userId = await this.getAuthUserId(req, false);
          if (!(await this.appealLimiter.check(`appeal:${userId}`))) {
            return reply.status(429).send({ error: 'Quá nhiều yêu cầu khiếu nại. Vui lòng thử lại sau.' });
          }
          const res = await this.safetyService.createAppeal(userId, req.body?.reason);
          return reply.status(201).send(res);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Gửi khiếu nại thất bại';
          return reply.status(400).send({ error: msg });
        }
      }
    );

    // GET /api/v1/appeals/me (View user's own appeal history and status)
    app.get('/api/v1/appeals/me', async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = await this.getAuthUserId(req, false);
        const appeals = await this.safetyService.listUserAppeals(userId);
        return reply.status(200).send({ appeals });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Lấy lịch sử khiếu nại thất bại';
        return reply.status(400).send({ error: msg });
      }
    });

    // POST /api/v1/reports
    app.post(
      '/api/v1/reports',
      async (
        req: FastifyRequest<{
          Body: {
            sessionId: string;
            reportedUserId: string;
            reason: ReportReason;
            description?: string;
            evidenceMessages?: Array<{ messageId: string }>;
          };
        }>,
        reply: FastifyReply
      ) => {
        try {
          const reporterId = await this.getAuthUserId(req, true);
          if (!(await this.reportLimiter.check(`report:${reporterId}`))) {
            return reply.status(429).send({ error: 'Quá nhiều yêu cầu báo cáo. Vui lòng chờ 1 phút trước khi gửi tiếp.' });
          }
          const res = await this.safetyService.createReport({
            sessionId: req.body.sessionId,
            reporterId,
            reportedUserId: req.body.reportedUserId,
            reason: req.body.reason,
            description: req.body.description,
            evidenceMessages: req.body.evidenceMessages || [],
          });
          return reply.status(201).send(res);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Gửi báo cáo thất bại';
          return reply.status(400).send({ error: msg });
        }
      }
    );
  }
}

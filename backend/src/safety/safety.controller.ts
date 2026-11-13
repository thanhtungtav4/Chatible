import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type Redis from 'ioredis';
import { SafetyService, ReportReason } from './safety.service.js';
import { DistributedRateLimiter } from '../auth/rate-limiter.js';
import { SafetyNotificationService } from './notification.service.js';
import { sendApiError } from '../http/api-error.js';
import { authenticateRequest } from '../http/route-auth.js';

export class SafetyController {
  private readonly reportLimiter = new DistributedRateLimiter(5, 60_000, 'rl:safety:report'); // 5 reports / min
  private readonly appealLimiter = new DistributedRateLimiter(3, 60_000, 'rl:safety:appeal'); // 3 appeals / min

  constructor(
    private readonly safetyService: SafetyService,
    private readonly notificationService: SafetyNotificationService = new SafetyNotificationService()
  ) {}

  setRedis(redis: Redis): void {
    this.reportLimiter.setRedis(redis);
    this.appealLimiter.setRedis(redis);
  }

  registerRoutes(app: FastifyInstance) {
    // POST /api/v1/blocks
    app.post('/api/v1/blocks', async (req: FastifyRequest<{ Body: { targetUserId: string } }>, reply: FastifyReply) => {
      try {
        const userId = await authenticateRequest(req, 'active_only');
        const res = await this.safetyService.blockUser(userId, req.body.targetUserId);
        return reply.status(200).send(res);
      } catch (err: unknown) {
        return sendApiError(reply, err, { fallbackStatus: 400, fallbackMessage: 'Chặn người dùng thất bại' });
      }
    });

    // GET /api/v1/blocks
    app.get('/api/v1/blocks', async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = await authenticateRequest(req, 'active_only');
        const blockedUsers = await this.safetyService.listBlockedUsers(userId);
        return reply.status(200).send({ blockedUsers });
      } catch (err: unknown) {
        return sendApiError(reply, err, { fallbackStatus: 500, fallbackCode: 'INTERNAL_ERROR', fallbackMessage: 'Lấy danh sách chặn thất bại' });
      }
    });

    // DELETE /api/v1/blocks/:targetUserId
    app.delete(
      '/api/v1/blocks/:targetUserId',
      async (req: FastifyRequest<{ Params: { targetUserId: string } }>, reply: FastifyReply) => {
        try {
          const userId = await authenticateRequest(req, 'active_only');
          const res = await this.safetyService.unblockUser(userId, req.params.targetUserId);
          return reply.status(200).send(res);
        } catch (err: unknown) {
          return sendApiError(reply, err, { fallbackStatus: 400, fallbackMessage: 'Bỏ chặn người dùng thất bại' });
        }
      }
    );

    // POST /api/v1/appeals (Allow RESTRICTED users to appeal)
    app.post(
      '/api/v1/appeals',
      async (req: FastifyRequest<{ Body: { reason: string } }>, reply: FastifyReply) => {
        try {
          const userId = await authenticateRequest(req, 'allow_restricted');
          if (!(await this.appealLimiter.check(`appeal:${userId}`))) {
            return reply.status(429).send({ error: 'Quá nhiều yêu cầu khiếu nại. Vui lòng thử lại sau.', code: 'RATE_LIMITED' });
          }
          const res = await this.safetyService.createAppeal(userId, req.body?.reason);
          return reply.status(201).send(res);
        } catch (err: unknown) {
          return sendApiError(reply, err, { fallbackStatus: 400, fallbackMessage: 'Gửi khiếu nại thất bại' });
        }
      }
    );

    // GET /api/v1/appeals/me (View user's own appeal history and status; allow RESTRICTED users)
    app.get('/api/v1/appeals/me', async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = await authenticateRequest(req, 'allow_restricted');
        const appeals = await this.safetyService.listUserAppeals(userId);
        return reply.status(200).send({ appeals });
      } catch (err: unknown) {
        return sendApiError(reply, err, { fallbackStatus: 500, fallbackCode: 'INTERNAL_ERROR', fallbackMessage: 'Lấy lịch sử khiếu nại thất bại' });
      }
    });

    // GET /api/v1/notifications (Safety notifications for active or restricted users; hides reporter identity)
    app.get('/api/v1/notifications', async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = await authenticateRequest(req, 'allow_restricted');
        const data = await this.notificationService.listUserNotifications(userId);
        return reply.status(200).send(data);
      } catch (err: unknown) {
        return sendApiError(reply, err, { fallbackStatus: 500, fallbackCode: 'INTERNAL_ERROR', fallbackMessage: 'Không thể tải thông báo.' });
      }
    });

    // POST /api/v1/notifications/read (Allow RESTRICTED users to mark notifications read)
    app.post(
      '/api/v1/notifications/read',
      async (req: FastifyRequest<{ Body?: { notificationId?: string } }>, reply: FastifyReply) => {
        try {
          const userId = await authenticateRequest(req, 'allow_restricted');
          const data = await this.notificationService.markRead(userId, req.body?.notificationId);
          return reply.status(200).send(data);
        } catch (err: unknown) {
          return sendApiError(reply, err, { fallbackStatus: 400, fallbackMessage: 'Không thể cập nhật trạng thái đã đọc.' });
        }
      }
    );

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
          const reporterId = await authenticateRequest(req, 'active_only');
          if (!(await this.reportLimiter.check(`report:${reporterId}`))) {
            return reply.status(429).send({ error: 'Quá nhiều yêu cầu báo cáo. Vui lòng chờ 1 phút trước khi gửi tiếp.', code: 'RATE_LIMITED' });
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
          return sendApiError(reply, err, { fallbackStatus: 400, fallbackMessage: 'Gửi báo cáo thất bại' });
        }
      }
    );
  }
}

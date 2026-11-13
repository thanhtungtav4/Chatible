import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Redis from 'ioredis';
import { DistributedRateLimiter } from '../auth/rate-limiter.js';
import { ApiError, sendApiError } from '../http/api-error.js';
import { authenticateRequest } from '../http/route-auth.js';
import { GroupsService } from './groups.service.js';
import type { ReportReason, SafetyService } from '../safety/safety.service.js';

export class GroupsController {
  private readonly joinLimiter = new DistributedRateLimiter(10, 60_000, 'rl:groups:join');
  private readonly messageLimiter = new DistributedRateLimiter(25, 60_000, 'rl:groups:msg');
  private readonly reportLimiter = new DistributedRateLimiter(5, 60_000, 'rl:groups:report');

  constructor(
    private readonly groupsService: GroupsService,
    private readonly safetyService?: SafetyService
  ) {}

  setRedis(redis: Redis): void {
    this.joinLimiter.setRedis(redis);
    this.messageLimiter.setRedis(redis);
    this.reportLimiter.setRedis(redis);
  }

  registerRoutes(app: FastifyInstance) {
    // GET /api/v1/groups
    app.get('/api/v1/groups', async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = await authenticateRequest(req, 'active_only');
        const rooms = await this.groupsService.listRooms(userId);
        return reply.status(200).send({ rooms });
      } catch (err: unknown) {
        return sendApiError(reply, err, {
          fallbackStatus: 500,
          fallbackCode: 'INTERNAL_ERROR',
          fallbackMessage: 'Không thể tải danh sách nhóm.',
        });
      }
    });

    // POST /api/v1/groups/:roomId/join (Join Public/Broadcast or Unlock Private Passcode room)
    app.post(
      '/api/v1/groups/:roomId/join',
      async (req: FastifyRequest<{ Params: { roomId: string }; Body: { passcode?: string } }>, reply: FastifyReply) => {
        try {
          const userId = await authenticateRequest(req, 'active_only');
          if (!(await this.joinLimiter.check(`join:${userId}:${req.params.roomId}`))) {
            throw ApiError.rateLimited('Thử quá nhiều lần. Vui lòng chờ một phút.');
          }
          const result = await this.groupsService.joinRoom(userId, req.params.roomId, req.body?.passcode);
          return reply.status(200).send(result);
        } catch (err: unknown) {
          return sendApiError(reply, err, { fallbackStatus: 400, fallbackMessage: 'Không thể tham gia phòng.' });
        }
      }
    );

    // GET /api/v1/groups/:roomId/messages
    app.get(
      '/api/v1/groups/:roomId/messages',
      async (req: FastifyRequest<{ Params: { roomId: string } }>, reply: FastifyReply) => {
        try {
          const userId = await authenticateRequest(req, 'active_only');
          const messages = await this.groupsService.listMessages(userId, req.params.roomId);
          return reply.status(200).send({ messages });
        } catch (err: unknown) {
          return sendApiError(reply, err, { fallbackStatus: 403, fallbackCode: 'FORBIDDEN', fallbackMessage: 'Không thể tải tin nhắn nhóm.' });
        }
      }
    );

    // POST /api/v1/groups/:roomId/messages
    app.post(
      '/api/v1/groups/:roomId/messages',
      async (
        req: FastifyRequest<{ Params: { roomId: string }; Body: { content: string; type?: string } }>,
        reply: FastifyReply
      ) => {
        try {
          const userId = await authenticateRequest(req, 'active_only');
          if (!(await this.messageLimiter.check(`msg:${userId}`))) {
            throw ApiError.rateLimited('Bạn đang gửi tin nhắn nhóm quá nhanh.');
          }
          const saved = await this.groupsService.postMessage(userId, req.params.roomId, req.body);
          return reply.status(201).send(saved);
        } catch (err: unknown) {
          return sendApiError(reply, err, { fallbackStatus: 400, fallbackMessage: 'Không thể gửi tin nhắn.' });
        }
      }
    );

    // POST /api/v1/groups/:roomId/messages/:messageId/report (Report violating message + auto-block author)
    app.post(
      '/api/v1/groups/:roomId/messages/:messageId/report',
      async (
        req: FastifyRequest<{
          Params: { roomId: string; messageId: string };
          Body: { reason: ReportReason; description?: string };
        }>,
        reply: FastifyReply
      ) => {
        try {
          const userId = await authenticateRequest(req, 'active_only');
          if (!this.safetyService) {
            throw ApiError.serviceUnavailable('Dịch vụ an toàn chưa sẵn sàng.');
          }
          if (!(await this.reportLimiter.check(`grp_rpt:${userId}`))) {
            throw ApiError.rateLimited('Bạn đang gửi báo cáo quá nhanh. Vui lòng thử lại sau 1 phút.');
          }
          const result = await this.safetyService.createGroupMessageReport({
            reporterId: userId,
            roomId: req.params.roomId,
            groupMessageId: req.params.messageId,
            reason: req.body?.reason,
            description: req.body?.description,
          });
          return reply.status(201).send(result);
        } catch (err: unknown) {
          const status = err instanceof Error && err.message.includes('thành viên') ? 403 : 400;
          return sendApiError(reply, err, { fallbackStatus: status, fallbackMessage: 'Không thể gửi báo cáo.' });
        }
      }
    );

    // POST /api/v1/groups/:roomId/messages/:messageId/block (Block offending member without exposing raw userId)
    app.post(
      '/api/v1/groups/:roomId/messages/:messageId/block',
      async (
        req: FastifyRequest<{ Params: { roomId: string; messageId: string } }>,
        reply: FastifyReply
      ) => {
        try {
          const userId = await authenticateRequest(req, 'active_only');
          if (!this.safetyService) {
            throw ApiError.serviceUnavailable('Dịch vụ an toàn chưa sẵn sàng.');
          }
          const author = await this.groupsService.getMessageAuthorForMember(
            userId,
            req.params.roomId,
            req.params.messageId
          );
          if (author.isAdmin) {
            throw ApiError.badRequest('Không thể chặn tài khoản Quản trị viên hệ thống.');
          }
          if (author.senderId === userId) {
            throw ApiError.badRequest('Không thể tự chặn chính mình.');
          }
          const result = await this.safetyService.blockUser(userId, author.senderId);
          return reply.status(200).send(result);
        } catch (err: unknown) {
          return sendApiError(reply, err, { fallbackStatus: 400, fallbackMessage: 'Không thể chặn người dùng này.' });
        }
      }
    );
  }
}

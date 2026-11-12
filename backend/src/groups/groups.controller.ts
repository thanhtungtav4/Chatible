import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Redis from 'ioredis';
import { DistributedRateLimiter } from '../auth/rate-limiter.js';
import { getAuthenticatedClaims } from '../auth/session-auth.util.js';
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

  private async getAuthUserId(req: FastifyRequest): Promise<string> {
    const claims = await getAuthenticatedClaims(req);
    return claims.sub;
  }

  registerRoutes(app: FastifyInstance) {
    // GET /api/v1/groups
    app.get('/api/v1/groups', async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = await this.getAuthUserId(req);
        const rooms = await this.groupsService.listRooms(userId);
        return reply.status(200).send({ rooms });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Yêu cầu xác thực tài khoản.';
        return reply.status(401).send({ error: msg });
      }
    });

    // POST /api/v1/groups/:roomId/join (Join Public/Broadcast or Unlock Private Passcode room)
    app.post(
      '/api/v1/groups/:roomId/join',
      async (req: FastifyRequest<{ Params: { roomId: string }; Body: { passcode?: string } }>, reply: FastifyReply) => {
        let userId: string;
        try {
          userId = await this.getAuthUserId(req);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Yêu cầu xác thực tài khoản.';
          return reply.status(401).send({ error: msg });
        }

        if (!(await this.joinLimiter.check(`join:${userId}:${req.params.roomId}`))) {
          return reply.status(429).send({ error: 'Thử quá nhiều lần. Vui lòng chờ một phút.' });
        }

        try {
          const result = await this.groupsService.joinRoom(userId, req.params.roomId, req.body?.passcode);
          return reply.status(200).send(result);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Không thể tham gia phòng.';
          const status = msg.includes('mật khẩu') ? 403 : 400;
          return reply.status(status).send({ error: msg });
        }
      }
    );

    // GET /api/v1/groups/:roomId/messages
    app.get(
      '/api/v1/groups/:roomId/messages',
      async (req: FastifyRequest<{ Params: { roomId: string } }>, reply: FastifyReply) => {
        let userId: string;
        try {
          userId = await this.getAuthUserId(req);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Yêu cầu xác thực tài khoản.';
          return reply.status(401).send({ error: msg });
        }

        try {
          const messages = await this.groupsService.listMessages(userId, req.params.roomId);
          return reply.status(200).send({ messages });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Không thể tải tin nhắn nhóm.';
          return reply.status(403).send({ error: msg });
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
        let userId: string;
        try {
          userId = await this.getAuthUserId(req);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Yêu cầu xác thực tài khoản.';
          return reply.status(401).send({ error: msg });
        }

        if (!(await this.messageLimiter.check(`msg:${userId}`))) {
          return reply.status(429).send({ error: 'Bạn đang gửi tin nhắn nhóm quá nhanh.' });
        }

        try {
          const saved = await this.groupsService.postMessage(userId, req.params.roomId, req.body);
          return reply.status(201).send(saved);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Không thể gửi tin nhắn.';
          const status = msg.includes('Quản trị viên') || msg.includes('mở khóa') ? 403 : 400;
          return reply.status(status).send({ error: msg });
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
        let userId: string;
        try {
          userId = await this.getAuthUserId(req);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Yêu cầu xác thực tài khoản.';
          return reply.status(401).send({ error: msg });
        }
        if (!this.safetyService) {
          return reply.status(503).send({ error: 'Dịch vụ an toàn chưa sẵn sàng.' });
        }
        if (!(await this.reportLimiter.check(`grp_rpt:${userId}`))) {
          return reply.status(429).send({ error: 'Bạn đang gửi báo cáo quá nhanh. Vui lòng thử lại sau 1 phút.' });
        }

        try {
          const result = await this.safetyService.createGroupMessageReport({
            reporterId: userId,
            roomId: req.params.roomId,
            groupMessageId: req.params.messageId,
            reason: req.body?.reason,
            description: req.body?.description,
          });
          return reply.status(201).send(result);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Không thể gửi báo cáo.';
          const status = msg.includes('thành viên') ? 403 : 400;
          return reply.status(status).send({ error: msg });
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
        let userId: string;
        try {
          userId = await this.getAuthUserId(req);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Yêu cầu xác thực tài khoản.';
          return reply.status(401).send({ error: msg });
        }
        if (!this.safetyService) {
          return reply.status(503).send({ error: 'Dịch vụ an toàn chưa sẵn sàng.' });
        }

        try {
          const author = await this.groupsService.getMessageAuthorForMember(
            userId,
            req.params.roomId,
            req.params.messageId
          );
          if (author.isAdmin) {
            return reply.status(400).send({ error: 'Không thể chặn tài khoản Quản trị viên hệ thống.' });
          }
          if (author.senderId === userId) {
            return reply.status(400).send({ error: 'Không thể tự chặn chính mình.' });
          }
          const result = await this.safetyService.blockUser(userId, author.senderId);
          return reply.status(200).send(result);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Không thể chặn người dùng này.';
          return reply.status(400).send({ error: msg });
        }
      }
    );
  }
}

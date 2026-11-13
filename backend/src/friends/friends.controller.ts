import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type Redis from 'ioredis';
import type { MessageType } from '@chatible/shared';
import { FriendsService } from './friends.service.js';
import { DistributedRateLimiter } from '../auth/rate-limiter.js';
import { sendApiError } from '../http/api-error.js';
import { authenticateRequest } from '../http/route-auth.js';

export class FriendsController {
  private readonly requestLimiter = new DistributedRateLimiter(10, 60_000, 'rl:friends:req');
  private readonly messageLimiter = new DistributedRateLimiter(30, 60_000, 'rl:friends:msg');

  constructor(private readonly friendsService: FriendsService) {}

  setRedis(redis: Redis): void {
    this.requestLimiter.setRedis(redis);
    this.messageLimiter.setRedis(redis);
  }

  registerRoutes(app: FastifyInstance) {
    // GET /api/v1/friends
    app.get('/api/v1/friends', async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = await authenticateRequest(req, 'active_only');
        const list = await this.friendsService.listFriends(userId);
        return reply.status(200).send({ friends: list });
      } catch (err: unknown) {
        return sendApiError(reply, err, {
          fallbackStatus: 500,
          fallbackCode: 'INTERNAL_ERROR',
          fallbackMessage: 'Lỗi lấy danh sách bạn bè',
        });
      }
    });

    app.get('/api/v1/friends/requests', async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = await authenticateRequest(req, 'active_only');
        const requests = await this.friendsService.listIncomingRequests(userId);
        return reply.status(200).send({ requests });
      } catch (err: unknown) {
        return sendApiError(reply, err, {
          fallbackStatus: 500,
          fallbackCode: 'INTERNAL_ERROR',
          fallbackMessage: 'Lỗi lấy lời mời kết bạn',
        });
      }
    });

    // POST /api/v1/friends/request
    app.post(
      '/api/v1/friends/request',
      async (req: FastifyRequest<{ Body: { targetUserId: string } }>, reply: FastifyReply) => {
        try {
          const userId = await authenticateRequest(req, 'active_only');
          if (!(await this.requestLimiter.check(`fr:${userId}`))) {
            return reply.status(429).send({ error: 'Quá nhiều yêu cầu kết bạn. Vui lòng thử lại sau 1 phút.', code: 'RATE_LIMITED' });
          }
          const res = await this.friendsService.sendFriendRequest(userId, req.body.targetUserId);
          return reply.status(200).send(res);
        } catch (err: unknown) {
          return sendApiError(reply, err, { fallbackStatus: 400, fallbackMessage: 'Gửi lời mời kết bạn thất bại' });
        }
      }
    );

    // POST /api/v1/friends/accept
    app.post(
      '/api/v1/friends/accept',
      async (req: FastifyRequest<{ Body: { requestId: string } }>, reply: FastifyReply) => {
        try {
          const userId = await authenticateRequest(req, 'active_only');
          const res = await this.friendsService.acceptFriendRequest(req.body.requestId, userId);
          return reply.status(200).send(res);
        } catch (err: unknown) {
          return sendApiError(reply, err, { fallbackStatus: 400, fallbackMessage: 'Chấp nhận kết bạn thất bại' });
        }
      }
    );

    // POST /api/v1/friends/decline
    app.post(
      '/api/v1/friends/decline',
      async (req: FastifyRequest<{ Body: { requestId: string } }>, reply: FastifyReply) => {
        try {
          const userId = await authenticateRequest(req, 'active_only');
          const res = await this.friendsService.declineFriendRequest(req.body.requestId, userId);
          return reply.status(200).send(res);
        } catch (err: unknown) {
          return sendApiError(reply, err, { fallbackStatus: 400, fallbackMessage: 'Từ chối kết bạn thất bại' });
        }
      }
    );

    // DELETE /api/v1/friends/requests/:requestId
    app.delete(
      '/api/v1/friends/requests/:requestId',
      async (req: FastifyRequest<{ Params: { requestId: string } }>, reply: FastifyReply) => {
        try {
          const userId = await authenticateRequest(req, 'active_only');
          const res = await this.friendsService.cancelFriendRequest(req.params.requestId, userId);
          return reply.status(200).send(res);
        } catch (err: unknown) {
          return sendApiError(reply, err, { fallbackStatus: 400, fallbackMessage: 'Thu hồi lời mời kết bạn thất bại' });
        }
      }
    );

    // DELETE /api/v1/friends/:friendId
    app.delete(
      '/api/v1/friends/:friendId',
      async (req: FastifyRequest<{ Params: { friendId: string } }>, reply: FastifyReply) => {
        try {
          const userId = await authenticateRequest(req, 'active_only');
          const res = await this.friendsService.unfriend(userId, req.params.friendId);
          return reply.status(200).send(res);
        } catch (err: unknown) {
          return sendApiError(reply, err, { fallbackStatus: 400, fallbackMessage: 'Hủy kết bạn thất bại' });
        }
      }
    );

    // GET /api/v1/friends/:friendId/session (Ensure friend session exists for media/adult-consent)
    app.get(
      '/api/v1/friends/:friendId/session',
      async (req: FastifyRequest<{ Params: { friendId: string } }>, reply: FastifyReply) => {
        try {
          const userId = await authenticateRequest(req, 'active_only');
          const info = await this.friendsService.getOrCreateFriendSession(userId, req.params.friendId);
          return reply.status(200).send(info);
        } catch (err: unknown) {
          return sendApiError(reply, err, {
            fallbackStatus: 403,
            fallbackCode: 'FORBIDDEN',
            fallbackMessage: 'Không thể mở phiên trò chuyện bạn bè',
          });
        }
      }
    );

    // GET /api/v1/friends/:friendId/messages (1-1 offline text & media messages, keyset paginated)
    app.get(
      '/api/v1/friends/:friendId/messages',
      async (
        req: FastifyRequest<{
          Params: { friendId: string };
          Querystring: { before?: string; limit?: string };
        }>,
        reply: FastifyReply
      ) => {
        try {
          const userId = await authenticateRequest(req, 'active_only');
          const parsedLimit =
            req.query.limit !== undefined && req.query.limit !== ''
              ? Number(req.query.limit)
              : undefined;
          const page = await this.friendsService.getConversationPage(userId, req.params.friendId, {
            before: req.query.before?.trim() || undefined,
            limit: parsedLimit,
          });
          return reply.status(200).send(page);
        } catch (err: unknown) {
          return sendApiError(reply, err, {
            fallbackStatus: 403,
            fallbackCode: 'FORBIDDEN',
            fallbackMessage: 'Lỗi tải tin nhắn bạn bè',
          });
        }
      }
    );

    // POST /api/v1/friends/:friendId/messages (Text + verified IMAGE/AUDIO/VIDEO media + 18+ consent)
    app.post(
      '/api/v1/friends/:friendId/messages',
      async (
        req: FastifyRequest<{
          Params: { friendId: string };
          Body: {
            content: string;
            type?: MessageType;
            mediaId?: string;
            isAdultContent?: boolean;
            metadata?: Record<string, unknown>;
            clientMessageId?: string;
          };
        }>,
        reply: FastifyReply
      ) => {
        try {
          const userId = await authenticateRequest(req, 'active_only');
          if (!(await this.messageLimiter.check(`fm:${userId}`))) {
            return reply.status(429).send({ error: 'Bạn gửi tin nhắn bạn bè quá nhanh. Vui lòng thử lại sau.', code: 'RATE_LIMITED' });
          }
          const body = req.body || { content: '' };
          const message = await this.friendsService.sendFriendMessage(userId, req.params.friendId, {
            content: body.content,
            type: body.type,
            mediaId: body.mediaId,
            isAdultContent: body.isAdultContent,
            metadata: body.metadata,
            clientMessageId: body.clientMessageId,
          });
          return reply.status(201).send(message);
        } catch (err: unknown) {
          return sendApiError(reply, err, { fallbackStatus: 400, fallbackMessage: 'Gửi tin nhắn bạn bè thất bại' });
        }
      }
    );
  }
}

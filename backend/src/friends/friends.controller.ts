import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type Redis from 'ioredis';
import type { MessageType } from '@chatible/shared';
import { FriendsService } from './friends.service.js';
import { DistributedRateLimiter } from '../auth/rate-limiter.js';
import { getAuthenticatedClaims } from '../auth/session-auth.util.js';

export class FriendsController {
  private readonly requestLimiter = new DistributedRateLimiter(10, 60_000, 'rl:friends:req');
  private readonly messageLimiter = new DistributedRateLimiter(30, 60_000, 'rl:friends:msg');

  constructor(private readonly friendsService: FriendsService) {}

  setRedis(redis: Redis): void {
    this.requestLimiter.setRedis(redis);
    this.messageLimiter.setRedis(redis);
  }

  private async getAuthUserId(req: FastifyRequest): Promise<string> {
    const claims = await getAuthenticatedClaims(req);
    return claims.sub;
  }

  registerRoutes(app: FastifyInstance) {
    // GET /api/v1/friends
    app.get('/api/v1/friends', async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = await this.getAuthUserId(req);
        const list = await this.friendsService.listFriends(userId);
        return reply.status(200).send({ friends: list });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Lỗi lấy danh sách bạn bè';
        return reply.status(401).send({ error: msg });
      }
    });

    app.get('/api/v1/friends/requests', async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = await this.getAuthUserId(req);
        const requests = await this.friendsService.listIncomingRequests(userId);
        return reply.status(200).send({ requests });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Lỗi lấy lời mời kết bạn';
        return reply.status(401).send({ error: msg });
      }
    });

    // POST /api/v1/friends/request
    app.post(
      '/api/v1/friends/request',
      async (req: FastifyRequest<{ Body: { targetUserId: string } }>, reply: FastifyReply) => {
        try {
          const userId = await this.getAuthUserId(req);
          if (!(await this.requestLimiter.check(`fr:${userId}`))) {
            return reply.status(429).send({ error: 'Quá nhiều yêu cầu kết bạn. Vui lòng thử lại sau 1 phút.' });
          }
          const res = await this.friendsService.sendFriendRequest(userId, req.body.targetUserId);
          return reply.status(200).send(res);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Gửi lời mời kết bạn thất bại';
          return reply.status(400).send({ error: msg });
        }
      }
    );

    // POST /api/v1/friends/accept
    app.post(
      '/api/v1/friends/accept',
      async (req: FastifyRequest<{ Body: { requestId: string } }>, reply: FastifyReply) => {
        try {
          const userId = await this.getAuthUserId(req);
          const res = await this.friendsService.acceptFriendRequest(req.body.requestId, userId);
          return reply.status(200).send(res);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Chấp nhận kết bạn thất bại';
          return reply.status(400).send({ error: msg });
        }
      }
    );

    // POST /api/v1/friends/decline
    app.post(
      '/api/v1/friends/decline',
      async (req: FastifyRequest<{ Body: { requestId: string } }>, reply: FastifyReply) => {
        try {
          const userId = await this.getAuthUserId(req);
          const res = await this.friendsService.declineFriendRequest(req.body.requestId, userId);
          return reply.status(200).send(res);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Từ chối kết bạn thất bại';
          return reply.status(400).send({ error: msg });
        }
      }
    );

    // DELETE /api/v1/friends/requests/:requestId
    app.delete(
      '/api/v1/friends/requests/:requestId',
      async (req: FastifyRequest<{ Params: { requestId: string } }>, reply: FastifyReply) => {
        try {
          const userId = await this.getAuthUserId(req);
          const res = await this.friendsService.cancelFriendRequest(req.params.requestId, userId);
          return reply.status(200).send(res);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Thu hồi lời mời kết bạn thất bại';
          return reply.status(400).send({ error: msg });
        }
      }
    );

    // DELETE /api/v1/friends/:friendId
    app.delete(
      '/api/v1/friends/:friendId',
      async (req: FastifyRequest<{ Params: { friendId: string } }>, reply: FastifyReply) => {
        try {
          const userId = await this.getAuthUserId(req);
          const res = await this.friendsService.unfriend(userId, req.params.friendId);
          return reply.status(200).send(res);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Hủy kết bạn thất bại';
          return reply.status(400).send({ error: msg });
        }
      }
    );

    // GET /api/v1/friends/:friendId/session (Ensure friend session exists for media/adult-consent)
    app.get(
      '/api/v1/friends/:friendId/session',
      async (req: FastifyRequest<{ Params: { friendId: string } }>, reply: FastifyReply) => {
        let userId: string;
        try {
          userId = await this.getAuthUserId(req);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Yêu cầu xác thực tài khoản.';
          return reply.status(401).send({ error: msg });
        }

        try {
          const info = await this.friendsService.getOrCreateFriendSession(userId, req.params.friendId);
          return reply.status(200).send(info);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Không thể mở phiên trò chuyện bạn bè';
          return reply.status(403).send({ error: msg });
        }
      }
    );

    // GET /api/v1/friends/:friendId/messages (1-1 offline text & media messages)
    app.get(
      '/api/v1/friends/:friendId/messages',
      async (req: FastifyRequest<{ Params: { friendId: string } }>, reply: FastifyReply) => {
        let userId: string;
        try {
          userId = await this.getAuthUserId(req);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Yêu cầu xác thực tài khoản.';
          return reply.status(401).send({ error: msg });
        }

        try {
          const list = await this.friendsService.getConversation(userId, req.params.friendId);
          return reply.status(200).send({ messages: list });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Lỗi tải tin nhắn bạn bè';
          return reply.status(403).send({ error: msg });
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
        let userId: string;
        try {
          userId = await this.getAuthUserId(req);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Yêu cầu xác thực tài khoản.';
          return reply.status(401).send({ error: msg });
        }

        try {
          if (!(await this.messageLimiter.check(`fm:${userId}`))) {
            return reply.status(429).send({ error: 'Bạn gửi tin nhắn bạn bè quá nhanh. Vui lòng thử lại sau.' });
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
          const msg = err instanceof Error ? err.message : 'Gửi tin nhắn bạn bè thất bại';
          return reply.status(400).send({ error: msg });
        }
      }
    );
  }
}

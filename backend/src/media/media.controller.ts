import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Redis from 'ioredis';
import { getAuthenticatedClaims } from '../auth/session-auth.util.js';
import { DistributedRateLimiter } from '../auth/rate-limiter.js';
import { MediaError, MediaProcessingPendingError, MediaService } from './media.service.js';
import type { MediaType } from './media.service.js';

type MediaBody = Record<string, unknown>;

export class MediaController {
  private readonly presignLimiter = new DistributedRateLimiter(20, 60_000, 'rl:media:presign');
  private readonly viewTokenLimiter = new DistributedRateLimiter(45, 60_000, 'rl:media:view');

  constructor(private readonly mediaService: MediaService = new MediaService()) {}

  setRedis(redis: Redis): void {
    this.presignLimiter.setRedis(redis);
    this.viewTokenLimiter.setRedis(redis);
  }

  private async getAuthUserId(req: FastifyRequest): Promise<string> {
    try {
      const claims = await getAuthenticatedClaims(req);
      return claims.sub;
    } catch (err) {
      throw new MediaError(401, err instanceof Error ? err.message : 'Yêu cầu xác thực tài khoản.');
    }
  }

  private sendError(reply: FastifyReply, error: unknown) {
    if (error instanceof MediaProcessingPendingError) {
      return reply
        .status(202)
        .header('Retry-After', String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))))
        .send({
          status: 'PROCESSING',
          retryAfterMs: error.retryAfterMs,
          message: error.message,
        });
    }
    const status = error instanceof MediaError ? error.statusCode : 500;
    const message = error instanceof Error ? error.message : 'Media request failed.';
    return reply.status(status).send({ error: message });
  }

  registerRoutes(app: FastifyInstance) {
    app.post('/api/v1/media/presign-upload', async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = await this.getAuthUserId(req);
        if (!(await this.presignLimiter.check(userId))) {
          return reply.status(429).send({ error: 'Bạn đang tải media lên quá nhanh. Vui lòng thử lại sau ít phút.' });
        }
        const body = (req.body || {}) as MediaBody;
        const sessionId = String(body.sessionId ?? body.session_id ?? '');
        const recipientId = String(body.recipientId ?? body.recipient_id ?? '');
        const contentType = String(body.contentType ?? body.content_type ?? '');
        const mediaType = String(body.mediaType ?? body.media_type ?? '').toUpperCase() as MediaType;
        const fileSize = Number(body.fileSize ?? body.file_size);
        const dek = String(body.dek ?? '');
        const iv = String(body.iv ?? '');
        const authTag = String(body.authTag ?? body.auth_tag ?? '');
        const result = await this.mediaService.presignUpload(userId, {
          sessionId,
          recipientId,
          contentType,
          mediaType,
          fileSize,
          dek,
          iv,
          authTag,
          isAdult: body.isAdult === true || body.is_adult === true,
          senderConfirmed18Plus:
            body.senderConfirmed18Plus === true || body.sender_confirmed_18_plus === true,
          senderConfirmedConsent:
            body.senderConfirmedConsent === true || body.sender_confirmed_consent === true,
        });
        return reply.status(200).send({
          media_id: result.mediaId,
          mediaId: result.mediaId,
          upload_url: result.uploadUrl,
          uploadUrl: result.uploadUrl,
          expires_at: result.expiresAt.toISOString(),
          expiresAt: result.expiresAt.toISOString(),
        });
      } catch (error) {
        return this.sendError(reply, error);
      }
    });

    app.post(
      '/api/v1/media/:mediaId/complete',
      async (req: FastifyRequest<{ Params: { mediaId: string } }>, reply: FastifyReply) => {
        try {
          const userId = await this.getAuthUserId(req);
          const result = await this.mediaService.completeUpload(userId, req.params.mediaId);
          return reply.status(200).send(result);
        } catch (error) {
          return this.sendError(reply, error);
        }
      }
    );

    app.get(
      '/api/v1/media/consent/:sessionId',
      async (req: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) => {
        try {
          const userId = await this.getAuthUserId(req);
          const state = await this.mediaService.getConsentState(userId, req.params.sessionId);
          return reply.status(200).send(state);
        } catch (error) {
          return this.sendError(reply, error);
        }
      }
    );

    app.post('/api/v1/media/consent', async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = await this.getAuthUserId(req);
        const body = (req.body || {}) as MediaBody;
        const sessionId = String(body.sessionId ?? body.session_id ?? '');
        const enabled = body.enabled === true || body.accepted === true;
        const requestedRecipientId = body.recipientId ?? body.recipient_id;
        await this.mediaService.setConsent(
          userId,
          sessionId,
          enabled,
          requestedRecipientId == null ? undefined : String(requestedRecipientId)
        );
        return reply.status(200).send({ enabled });
      } catch (error) {
        return this.sendError(reply, error);
      }
    });

    app.post('/api/v1/media/adult-consent', async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = await this.getAuthUserId(req);
        const body = (req.body || {}) as MediaBody;
        const sessionId = String(body.sessionId ?? body.session_id ?? '');
        const enabled = body.enabled === true || body.accepted === true;
        const policyAcknowledged =
          body.policyAcknowledged === true || body.policy_acknowledged === true;
        const requestedRecipientId = body.recipientId ?? body.recipient_id;
        await this.mediaService.setAdultConsent(
          userId,
          sessionId,
          enabled,
          policyAcknowledged,
          requestedRecipientId == null ? undefined : String(requestedRecipientId)
        );
        return reply.status(200).send({ enabled, policyAcknowledged });
      } catch (error) {
        return this.sendError(reply, error);
      }
    });

    app.get(
      '/api/v1/media/:mediaId/view-token',
      async (req: FastifyRequest<{ Params: { mediaId: string } }>, reply: FastifyReply) => {
        try {
          const userId = await this.getAuthUserId(req);
          if (!(await this.viewTokenLimiter.check(userId))) {
            return reply.status(429).send({ error: 'Yêu cầu xem media quá nhanh. Vui lòng thử lại sau.' });
          }
          const result = await this.mediaService.issueViewToken(userId, req.params.mediaId);
          return reply
            .header('Cache-Control', 'private, no-store')
            .status(200)
            .send({
              view_token: result.viewToken,
              viewToken: result.viewToken,
              dek: result.dek,
              watermark_text: result.watermarkText,
              watermarkText: result.watermarkText,
              trace_code: result.traceCode,
              traceCode: result.traceCode,
              expires_in: result.expiresIn,
              expires_at: result.expiresAt.toISOString(),
              content_type: result.contentType,
              media_type: result.mediaType,
              iv: result.iv,
              auth_tag: result.authTag,
            });
        } catch (error) {
          return this.sendError(reply, error);
        }
      }
    );

    app.get(
      '/api/v1/media/stream/:mediaId',
      async (req: FastifyRequest<{ Params: { mediaId: string } }>, reply: FastifyReply) => {
        try {
          const userId = await this.getAuthUserId(req);
          const rawToken = req.headers['x-media-view-token'];
          const result = await this.mediaService.openStream(
            userId,
            req.params.mediaId,
            typeof rawToken === 'string' ? rawToken : ''
          );
          reply
            .header('Content-Type', result.contentType)
            .header('Cache-Control', 'private, no-store')
            .header('Referrer-Policy', 'no-referrer')
            .header('X-Content-Type-Options', 'nosniff');
          if (result.iv) reply.header('X-Media-Iv', result.iv);
          if (result.authTag) reply.header('X-Media-Auth-Tag', result.authTag);
          if (result.mediaContentType) reply.header('X-Media-Content-Type', result.mediaContentType);
          reply.header('X-Media-Watermarked', result.watermarked ? 'embedded' : 'overlay');
          if (result.contentLength != null) reply.header('Content-Length', result.contentLength);
          return reply.send(result.body);
        } catch (error) {
          return this.sendError(reply, error);
        }
      }
    );

    app.post(
      '/api/v1/media/:mediaId/revoke',
      async (req: FastifyRequest<{ Params: { mediaId: string } }>, reply: FastifyReply) => {
        try {
          const userId = await this.getAuthUserId(req);
          await this.mediaService.revoke(userId, req.params.mediaId);
          return reply.status(200).send({ revoked: true });
        } catch (error) {
          return this.sendError(reply, error);
        }
      }
    );
  }
}

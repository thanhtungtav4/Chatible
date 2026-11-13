import type { FastifyReply } from 'fastify';

export type ApiErrorCode =
  | 'UNAUTHORIZED'
  | 'ACCOUNT_RESTRICTED'
  | 'FORBIDDEN'
  | 'VAULT_LOCKED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'BAD_REQUEST'
  | 'GONE'
  | 'UNSUPPORTED_MEDIA'
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly extraPayload?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static unauthorized(message = 'Yêu cầu xác thực tài khoản.'): ApiError {
    return new ApiError(401, 'UNAUTHORIZED', message);
  }

  static restricted(
    message = 'Tài khoản đã bị khóa hoặc đình chỉ do vi phạm chính sách cộng đồng.'
  ): ApiError {
    return new ApiError(403, 'ACCOUNT_RESTRICTED', message);
  }

  static forbidden(message = 'Bạn không có quyền thực hiện thao tác này.'): ApiError {
    return new ApiError(403, 'FORBIDDEN', message);
  }

  static vaultLocked(
    message = 'Kho riêng tư đang khóa. Vui lòng nhập mã PIN để mở khóa.'
  ): ApiError {
    return new ApiError(423, 'VAULT_LOCKED', message, { vaultLocked: true });
  }

  static notFound(message = 'Không tìm thấy tài nguyên yêu cầu.'): ApiError {
    return new ApiError(404, 'NOT_FOUND', message);
  }

  static conflict(message: string): ApiError {
    return new ApiError(409, 'CONFLICT', message);
  }

  static badRequest(message: string): ApiError {
    return new ApiError(400, 'BAD_REQUEST', message);
  }

  static gone(message: string): ApiError {
    return new ApiError(410, 'GONE', message);
  }

  static rateLimited(message: string): ApiError {
    return new ApiError(429, 'RATE_LIMITED', message);
  }

  static serviceUnavailable(message: string): ApiError {
    return new ApiError(503, 'SERVICE_UNAVAILABLE', message);
  }

  static internal(message = 'Lỗi hệ thống nội bộ.'): ApiError {
    return new ApiError(500, 'INTERNAL_ERROR', message);
  }
}

export interface ErrorFallbackOptions {
  fallbackStatus?: number;
  fallbackCode?: ApiErrorCode;
  fallbackMessage?: string;
}

interface ErrorWithHttpMetadata {
  statusCode?: unknown;
  retryAfterMs?: unknown;
  code?: unknown;
  message?: unknown;
  name?: unknown;
}

function isInfrastructureError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as ErrorWithHttpMetadata;
  if (candidate.name === 'PostgresError') return true;
  if (typeof candidate.code === 'string') {
    return (
      candidate.code === 'ECONNREFUSED' ||
      candidate.code === 'ECONNRESET' ||
      candidate.code === 'ETIMEDOUT' ||
      candidate.code === '57P01' ||
      candidate.code === '08006' ||
      candidate.code === '08003' ||
      candidate.code === '53300'
    );
  }
  return false;
}

function logInternalError(reply: FastifyReply, err: unknown, contextMessage: string): void {
  const logger = (reply as unknown as { request?: { log?: { error?: (obj: unknown, msg?: string) => void } } }).request?.log;
  if (logger?.error) {
    logger.error({ err }, contextMessage);
  } else {
    console.error(`[API Internal Error] ${contextMessage}:`, err);
  }
}

/**
 * Centralized HTTP error serializer mapping ApiError, MediaError/202 pending,
 * infrastructure failures, and legacy Error instances consistently to HTTP responses.
 */
export function sendApiError(
  reply: FastifyReply,
  err: unknown,
  options: ErrorFallbackOptions = {}
): FastifyReply {
  if (err && typeof err === 'object') {
    const meta = err as ErrorWithHttpMetadata;
    if (
      meta.statusCode === 202 &&
      typeof meta.retryAfterMs === 'number' &&
      Number.isFinite(meta.retryAfterMs)
    ) {
      return reply
        .status(202)
        .header('Retry-After', String(Math.max(1, Math.ceil(meta.retryAfterMs / 1000))))
        .send({
          status: 'PROCESSING',
          retryAfterMs: meta.retryAfterMs,
          message: err instanceof Error ? err.message : 'Đang xử lý media.',
        });
    }
  }

  if (err instanceof ApiError) {
    return reply.status(err.statusCode).send({
      error: err.message,
      code: err.code,
      ...(err.extraPayload || {}),
    });
  }

  if (err && typeof err === 'object') {
    const status = (err as ErrorWithHttpMetadata).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 600) {
      if (status >= 500 && status !== 501 && status !== 503) {
        const generic = options.fallbackMessage || 'Lỗi hệ thống nội bộ.';
        logInternalError(reply, err, generic);
        return reply.status(500).send({ error: generic, code: 'INTERNAL_ERROR' });
      }
      const message =
        err instanceof Error ? err.message : options.fallbackMessage || 'Yêu cầu thất bại.';
      return reply.status(status).send({ error: message });
    }
  }

  if (isInfrastructureError(err)) {
    const generic = options.fallbackMessage || 'Lỗi kết nối cơ sở dữ liệu.';
    logInternalError(reply, err, generic);
    return reply.status(500).send({
      error: generic,
      code: 'INTERNAL_ERROR',
    });
  }

  const statusCode = options.fallbackStatus ?? 400;
  const code = options.fallbackCode ?? (statusCode >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');
  if (statusCode >= 500) {
    const generic = options.fallbackMessage || 'Lỗi hệ thống nội bộ.';
    logInternalError(reply, err, generic);
    return reply.status(statusCode).send({ error: generic, code });
  }

  const message =
    err instanceof Error && err.message
      ? err.message
      : options.fallbackMessage || 'Yêu cầu thất bại.';

  return reply.status(statusCode).send({ error: message, code });
}

import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Redis from 'ioredis';
import { config } from '../config/env.js';
import { JwtPayload, JwtUtil } from './jwt.util.js';

export const SESSION_COOKIE_NAME = 'chatible_session';
export const CSRF_COOKIE_NAME = 'chatible_csrf';
export const ADMIN_CSRF_COOKIE_NAME = 'chatible_admin_csrf';
export const VAULT_COOKIE_NAME = 'chatible_vault_unlock';
export const ADMIN_COOKIE_NAME = 'chatible_admin_session';

export class TokenRevocationStore {
  private redis?: Redis;
  private readonly revokedJtis = new Map<string, number>();
  private readonly revokedUsersBefore = new Map<string, number>();

  setRedis(redis: Redis): void {
    this.redis = redis;
  }

  async revokeJti(jti: string, ttlSeconds: number = 86400): Promise<void> {
    if (!jti) return;
    const expiresAtMs = Date.now() + ttlSeconds * 1000;
    this.revokedJtis.set(jti, expiresAtMs);
    if (this.redis) {
      await this.redis.set(`revoked:jti:${jti}`, '1', 'EX', Math.max(1, ttlSeconds)).catch(() => {});
    }
  }

  async revokeUserTokensBefore(userId: string, beforeUnixMs: number = Date.now()): Promise<void> {
    if (!userId) return;
    this.revokedUsersBefore.set(userId, beforeUnixMs);
    if (this.redis) {
      await this.redis
        .set(`revoked:user_before:${userId}`, String(beforeUnixMs), 'EX', 86400 * 7)
        .catch(() => {});
    }
  }

  async isTokenRevoked(payload: JwtPayload): Promise<boolean> {
    const nowMs = Date.now();
    if (payload.jti) {
      const memExp = this.revokedJtis.get(payload.jti);
      if (memExp && memExp > nowMs) return true;
      if (this.redis) {
        const val = await this.redis.get(`revoked:jti:${payload.jti}`).catch(() => null);
        if (val === '1') return true;
      }
    }

    const tokenIssuedMs =
      typeof payload.issuedAtMs === 'number'
        ? payload.issuedAtMs
        : typeof payload.iat === 'number'
          ? payload.iat * 1000
          : null;

    if (payload.sub && tokenIssuedMs !== null) {
      const memBefore = this.revokedUsersBefore.get(payload.sub);
      if (memBefore !== undefined && tokenIssuedMs < memBefore) return true;
      if (this.redis) {
        const val = await this.redis.get(`revoked:user_before:${payload.sub}`).catch(() => null);
        if (val !== null) {
          const parsed = Number.parseInt(val, 10);
          if (Number.isFinite(parsed) && tokenIssuedMs < parsed) return true;
        }
      }
    }

    return false;
  }
}

export const tokenRevocationStore = new TokenRevocationStore();

export function parseCookieHeader(cookieHeader?: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) return result;
  for (const part of cookieHeader.split(';')) {
    const eqIndex = part.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = part.slice(0, eqIndex).trim();
    const rawVal = part.slice(eqIndex + 1).trim();
    try {
      result[key] = decodeURIComponent(rawVal);
    } catch {
      result[key] = rawVal;
    }
  }
  return result;
}

export function getRequestCookies(req: FastifyRequest): Record<string, string> {
  const fastifyCookies = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies;
  if (fastifyCookies && Object.keys(fastifyCookies).length > 0) {
    return fastifyCookies;
  }
  return parseCookieHeader(req.headers.cookie);
}

export function extractUserCookieToken(req: FastifyRequest): string | null {
  const cookies = getRequestCookies(req);
  return cookies[SESSION_COOKIE_NAME] || null;
}

export async function verifyUserSessionToken(token: string): Promise<JwtPayload> {
  const claims = JwtUtil.verify(token, config.jwtSecret);
  if (claims.role === 'admin' || claims.scope === 'vault_unlock' || !claims.sub) {
    throw new Error('Token không hợp lệ cho phiên người dùng.');
  }
  if (await tokenRevocationStore.isTokenRevoked(claims)) {
    throw new Error('Phiên đăng nhập đã bị thu hồi hoặc đăng xuất.');
  }
  return claims;
}

export async function getAuthenticatedClaims(req: FastifyRequest): Promise<JwtPayload> {
  const token = extractUserCookieToken(req);
  if (!token) {
    throw new Error('Yêu cầu xác thực tài khoản.');
  }
  return verifyUserSessionToken(token);
}

function appendSetCookie(reply: FastifyReply, cookieStr: string): void {
  const existing = reply.getHeader('set-cookie');
  if (!existing) {
    reply.header('set-cookie', [cookieStr]);
  } else if (Array.isArray(existing)) {
    reply.header('set-cookie', [...existing, cookieStr]);
  } else {
    reply.header('set-cookie', [String(existing), cookieStr]);
  }
}

function formatCookie(
  name: string,
  value: string,
  options: { httpOnly: boolean; maxAge: number; sameSite?: 'Lax' | 'Strict'; path?: string }
): string {
  const isProd = process.env.NODE_ENV === 'production';
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path ?? '/'}`,
    `Max-Age=${options.maxAge}`,
    `SameSite=${options.sameSite ?? 'Lax'}`,
  ];
  if (options.httpOnly) parts.push('HttpOnly');
  if (isProd) parts.push('Secure');
  return parts.join('; ');
}

export function setAuthCookies(reply: FastifyReply, jwtToken: string, maxAgeSeconds = 86400): string {
  const csrfToken = crypto.randomBytes(24).toString('base64url');
  appendSetCookie(reply, formatCookie(SESSION_COOKIE_NAME, jwtToken, { httpOnly: true, maxAge: maxAgeSeconds }));
  appendSetCookie(reply, formatCookie(CSRF_COOKIE_NAME, csrfToken, { httpOnly: false, maxAge: maxAgeSeconds }));
  return csrfToken;
}

export function clearAuthCookies(reply: FastifyReply): void {
  appendSetCookie(reply, formatCookie(SESSION_COOKIE_NAME, '', { httpOnly: true, maxAge: 0 }));
  appendSetCookie(reply, formatCookie(CSRF_COOKIE_NAME, '', { httpOnly: false, maxAge: 0 }));
  appendSetCookie(reply, formatCookie(VAULT_COOKIE_NAME, '', { httpOnly: true, maxAge: 0, sameSite: 'Strict' }));
}

function vaultSigningKey(): string {
  return `${config.jwtSecret}:vault_scope_v1`;
}

export function issueVaultUnlockToken(userId: string, expiresInSeconds = 600): string {
  return JwtUtil.sign(
    {
      sub: userId,
      email: 'vault@chatible.internal',
      scope: 'vault_unlock',
    },
    vaultSigningKey(),
    expiresInSeconds
  );
}

export function setVaultUnlockCookie(reply: FastifyReply, vaultToken: string, maxAgeSeconds = 600): void {
  appendSetCookie(
    reply,
    formatCookie(VAULT_COOKIE_NAME, vaultToken, {
      httpOnly: true,
      maxAge: maxAgeSeconds,
      sameSite: 'Strict',
    })
  );
}

export function clearVaultUnlockCookie(reply: FastifyReply): void {
  appendSetCookie(
    reply,
    formatCookie(VAULT_COOKIE_NAME, '', {
      httpOnly: true,
      maxAge: 0,
      sameSite: 'Strict',
    })
  );
}

export async function verifyVaultUnlocked(req: FastifyRequest, userId: string): Promise<boolean> {
  const cookies = getRequestCookies(req);
  const rawToken = cookies[VAULT_COOKIE_NAME] || '';
  if (!rawToken) return false;

  try {
    const claims = JwtUtil.verify(rawToken, vaultSigningKey());
    if (claims.scope !== 'vault_unlock' || claims.sub !== userId) return false;
    if (await tokenRevocationStore.isTokenRevoked(claims)) return false;
    return true;
  } catch {
    return false;
  }
}

export function setAdminSessionCookie(reply: FastifyReply, adminToken: string, maxAgeSeconds = 900): string {
  const csrfToken = crypto.randomBytes(24).toString('base64url');
  appendSetCookie(
    reply,
    formatCookie(ADMIN_COOKIE_NAME, adminToken, {
      httpOnly: true,
      maxAge: maxAgeSeconds,
      sameSite: 'Strict',
    })
  );
  appendSetCookie(
    reply,
    formatCookie(ADMIN_CSRF_COOKIE_NAME, csrfToken, {
      httpOnly: false,
      maxAge: maxAgeSeconds,
      sameSite: 'Strict',
    })
  );
  return csrfToken;
}

export function clearAdminSessionCookie(reply: FastifyReply, clearCsrf = true): void {
  appendSetCookie(
    reply,
    formatCookie(ADMIN_COOKIE_NAME, '', {
      httpOnly: true,
      maxAge: 0,
      sameSite: 'Strict',
    })
  );
  if (clearCsrf) {
    appendSetCookie(
      reply,
      formatCookie(ADMIN_CSRF_COOKIE_NAME, '', {
        httpOnly: false,
        maxAge: 0,
        sameSite: 'Strict',
      })
    );
  }
}

export function registerCsrfOriginProtection(app: FastifyInstance): void {
  const mutatingMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  const preAuthBypassPaths = new Set([
    '/api/v1/auth/login',
    '/api/v1/auth/register',
    '/api/v1/auth/google',
    '/api/v1/auth/forgot-password',
    '/api/v1/auth/reset-password',
    '/api/v1/auth/logout',
    '/api/v1/admin/auth',
  ]);

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!mutatingMethods.has(req.method)) return;

    const origin = req.headers.origin;
    if (origin && !config.corsOrigins.includes(origin)) {
      return reply.status(403).send({ error: 'Yêu cầu bị từ chối bởi chính sách Origin/CORS.' });
    }

    const cookies = getRequestCookies(req);
    const urlPath = req.url.split('?', 1)[0] ?? req.url;
    const isAdminRoute = urlPath.startsWith('/api/v1/admin');
    const hasScopedSession = isAdminRoute
      ? Boolean(cookies[ADMIN_COOKIE_NAME])
      : Boolean(cookies[SESSION_COOKIE_NAME]);

    // Web routes are cookie-only with isolated user/admin CSRF tokens so admin logout never breaks user sessions.
    if (hasScopedSession && !preAuthBypassPaths.has(urlPath)) {
      const csrfCookie = (isAdminRoute ? cookies[ADMIN_CSRF_COOKIE_NAME] : cookies[CSRF_COOKIE_NAME]) || '';
      const csrfHeader = typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : '';
      const cookieBuf = Buffer.from(csrfCookie);
      const headerBuf = Buffer.from(csrfHeader);
      if (
        !csrfCookie ||
        !csrfHeader ||
        cookieBuf.length !== headerBuf.length ||
        !crypto.timingSafeEqual(cookieBuf, headerBuf)
      ) {
        return reply.status(403).send({ error: 'Thiếu hoặc sai mã xác thực chống CSRF.' });
      }
    }
  });
}

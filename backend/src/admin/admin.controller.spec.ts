import { describe, expect, it } from 'bun:test';
import fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { JwtUtil } from '../auth/jwt.util.js';
import { config } from '../config/env.js';
import {
  ADMIN_COOKIE_NAME,
  ADMIN_CSRF_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  registerCsrfOriginProtection,
  SESSION_COOKIE_NAME,
} from '../auth/session-auth.util.js';

function parseCookies(header: string | string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const raw of Array.isArray(header) ? header : [header]) {
    const first = raw.split(';', 1)[0] || '';
    const idx = first.indexOf('=');
    if (idx > 0) out[first.slice(0, idx).trim()] = decodeURIComponent(first.slice(idx + 1).trim());
  }
  return out;
}

describe('Admin cookie-only & CSRF authorization', () => {
  it('exchanges the configured secret for HttpOnly cookie + CSRF cookie and rejects Bearer or forged credentials', async () => {
    const originalAdminSecret = config.adminSecret;
    const originalJwtSecret = config.jwtSecret;
    const originalAdminJwtSecret = config.adminJwtSecret;
    const originalSuperAdminId = config.superAdminId;
    config.adminSecret = 'configured-admin-secret';
    config.jwtSecret = 'test-jwt-secret-with-at-least-32-bytes';
    config.adminJwtSecret = 'test-admin-jwt-secret-with-at-least-32-bytes';
    config.superAdminId = '123e4567-e89b-42d3-a456-426614174000';

    const adminService = { getStats: async () => ({ totalUsers: 3 }) } as unknown as AdminService;
    const app = fastify();
    await app.register(fastifyCookie);
    registerCsrfOriginProtection(app);
    new AdminController(adminService).registerRoutes(app);

    try {
      const unauthorized = await app.inject({ method: 'GET', url: '/api/v1/admin/stats' });
      expect(unauthorized.statusCode).toBe(401);

      const rawSecretResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/stats',
        headers: { authorization: `Bearer ${config.adminSecret}`, 'x-admin-token': config.adminSecret },
      });
      expect(rawSecretResponse.statusCode).toBe(401);

      // User token signed with regular jwtSecret cannot access admin routes (SEC-05)
      const userTokenWithAdminClaim = JwtUtil.sign(
        { sub: config.superAdminId, email: 'admin@chatible.local', role: 'admin' },
        config.jwtSecret,
        3600
      );
      const userTokenResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/stats',
        headers: { cookie: `${ADMIN_COOKIE_NAME}=${encodeURIComponent(userTokenWithAdminClaim)}` },
      });
      expect(userTokenResponse.statusCode).toBe(401);

      const wrongRole = JwtUtil.sign(
        { sub: config.superAdminId, email: 'admin@chatible.local' },
        config.adminJwtSecret,
        3600
      );
      const wrongRoleResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/stats',
        headers: { cookie: `${ADMIN_COOKIE_NAME}=${encodeURIComponent(wrongRole)}` },
      });
      expect(wrongRoleResponse.statusCode).toBe(401);

      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth',
        payload: { secret: config.adminSecret },
      });
      expect(login.statusCode).toBe(200);
      expect(login.json().accessToken).toBeUndefined();

      const cookies = parseCookies(login.headers['set-cookie']);
      expect(cookies[ADMIN_COOKIE_NAME]).toBeTruthy();
      expect(cookies[ADMIN_CSRF_COOKIE_NAME]).toBeTruthy();
      expect(cookies[CSRF_COOKIE_NAME]).toBeUndefined();

      // Bearer header must be rejected on web admin endpoints
      const bearerRejected = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/stats',
        headers: { authorization: `Bearer ${cookies[ADMIN_COOKIE_NAME]}` },
      });
      expect(bearerRejected.statusCode).toBe(401);

      const accepted = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/stats',
        headers: { cookie: `${ADMIN_COOKIE_NAME}=${encodeURIComponent(cookies[ADMIN_COOKIE_NAME]!)}` },
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toEqual({ totalUsers: 3 });

      // MFA disable endpoint is permanently forbidden
      const disableMfa = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/mfa/disable',
        headers: {
          cookie: `${ADMIN_COOKIE_NAME}=${encodeURIComponent(cookies[ADMIN_COOKIE_NAME]!)}; ${ADMIN_CSRF_COOKIE_NAME}=${encodeURIComponent(cookies[ADMIN_CSRF_COOKIE_NAME]!)}`,
          'x-csrf-token': cookies[ADMIN_CSRF_COOKIE_NAME]!,
        },
        payload: { code: '123456' },
      });
      expect(disableMfa.statusCode).toBe(403);
    } finally {
      await app.close();
      config.adminSecret = originalAdminSecret;
      config.jwtSecret = originalJwtSecret;
      config.adminJwtSecret = originalAdminJwtSecret;
      config.superAdminId = originalSuperAdminId;
    }
  });

  it('handles report resolution with conclusion and appeals processing using HttpOnly cookie + CSRF', async () => {
    const adminToken = JwtUtil.sign(
      { sub: config.superAdminId, email: 'admin@chatible.local', role: 'admin' },
      config.adminJwtSecret,
      3600
    );
    const csrfToken = 'test-csrf-token-admin-1';
    const adminCookie = `${ADMIN_COOKIE_NAME}=${encodeURIComponent(adminToken)}; ${ADMIN_CSRF_COOKIE_NAME}=${encodeURIComponent(csrfToken)}`;

    let resolvedReportParams: unknown = null;
    let resolvedAppealParams: unknown = null;

    const mockAdminService = {
      listReports: async () => [{ id: 'rep-1', reportedUserId: 'user-bad' }],
      resolveReport: async (id: string, actor: string, ip?: string, opts?: unknown) => {
        resolvedReportParams = { id, actor, opts };
        return { status: 'RESOLVED', reportId: id };
      },
      listAppeals: async () => [
        { id: 'app-1', userId: 'user-1', reason: 'Tôi bị oan', status: 'PENDING' },
      ],
      resolveAppeal: async (id: string, actor: string, decision: string, note?: string) => {
        resolvedAppealParams = { id, actor, decision, note };
        return { status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', appealId: id, userId: 'user-1' };
      },
    } as unknown as AdminService;

    const app = fastify();
    await app.register(fastifyCookie);
    registerCsrfOriginProtection(app);
    let revokedUser: string | null = null;
    const controller = new AdminController(mockAdminService);
    controller.setUserRevoker(async (uid) => {
      revokedUser = uid;
    });
    controller.registerRoutes(app);

    try {
      // Mutating call without X-CSRF-Token must fail 403
      const missingCsrf = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/reports/rep-1/resolve',
        headers: { cookie: adminCookie },
        payload: { conclusion: 'ACTION_TAKEN' },
      });
      expect(missingCsrf.statusCode).toBe(403);

      // 1. Resolve report with conclusion & restrictUser
      const reportRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/reports/rep-1/resolve',
        headers: { cookie: adminCookie, 'x-csrf-token': csrfToken },
        payload: { conclusion: 'ACTION_TAKEN', adminNote: 'Vi phạm nghiêm trọng', restrictUser: true },
      });
      expect(reportRes.statusCode).toBe(200);
      expect(resolvedReportParams).toMatchObject({
        id: 'rep-1',
        opts: { conclusion: 'ACTION_TAKEN', restrictUser: true },
      });
      expect(revokedUser).toBe('user-bad');

      // 2. List appeals
      const appealsRes = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/appeals',
        headers: { cookie: adminCookie },
      });
      expect(appealsRes.statusCode).toBe(200);
      expect(appealsRes.json()).toHaveLength(1);

      // 3. Resolve appeal (APPROVE)
      const appealRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/appeals/app-1/resolve',
        headers: { cookie: adminCookie, 'x-csrf-token': csrfToken },
        payload: { decision: 'APPROVE', adminNote: 'Chấp thuận mở khóa' },
      });
      expect(appealRes.statusCode).toBe(200);
      expect(resolvedAppealParams).toMatchObject({
        id: 'app-1',
        decision: 'APPROVE',
        note: 'Chấp thuận mở khóa',
      });
    } finally {
      await app.close();
    }
  });

  it('allows super admin to view and update system settings', async () => {
    const adminToken = JwtUtil.sign(
      { sub: config.superAdminId, email: 'admin@chatible.local', role: 'admin' },
      config.adminJwtSecret,
      3600
    );
    const csrfToken = 'test-csrf-token-admin-2';
    const adminCookie = `${ADMIN_COOKIE_NAME}=${encodeURIComponent(adminToken)}; ${ADMIN_CSRF_COOKIE_NAME}=${encodeURIComponent(csrfToken)}`;

    let updatedSettings: unknown = null;
    const mockAdminService = {
      getSettings: async () => [
        { key: 'auth.google.enabled', value: 'true', category: 'AUTH' },
        { key: 'auth.google.client_id', value: 'google-client-xyz', category: 'AUTH' },
      ],
      updateSettings: async (actor: string, updates: Record<string, string>) => {
        updatedSettings = { actor, updates };
        return { success: true, updatedCount: Object.keys(updates).length };
      },
      sendTestEmail: async (actor: string, toEmail: string, overrides?: unknown) => {
        if (!toEmail) throw new Error('Email không hợp lệ');
        return { success: true, message: `Đã gửi tới ${toEmail}`, actor, overrides };
      },
    } as unknown as AdminService;

    const app = fastify();
    await app.register(fastifyCookie);
    registerCsrfOriginProtection(app);
    new AdminController(mockAdminService).registerRoutes(app);

    try {
      // 1. GET settings
      const getRes = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/settings',
        headers: { cookie: adminCookie },
      });
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json()).toHaveLength(2);

      // 2. PUT settings
      const putRes = await app.inject({
        method: 'PUT',
        url: '/api/v1/admin/settings',
        headers: { cookie: adminCookie, 'x-csrf-token': csrfToken },
        payload: {
          settings: {
            'auth.google.enabled': 'false',
            'auth.google.client_id': 'new-google-client-id',
          },
        },
      });
      expect(putRes.statusCode).toBe(200);
      expect(putRes.json().success).toBe(true);
      expect(updatedSettings).toMatchObject({
        actor: config.superAdminId,
        updates: {
          'auth.google.enabled': 'false',
          'auth.google.client_id': 'new-google-client-id',
        },
      });

      // 3. POST test email
      const testMailRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/settings/test-email',
        headers: { cookie: adminCookie, 'x-csrf-token': csrfToken },
        payload: {
          toEmail: 'admin-verify@example.com',
          smtpConfig: { host: 'smtp.gmail.com', port: '587' },
        },
      });
      expect(testMailRes.statusCode).toBe(200);
      expect(testMailRes.json().success).toBe(true);
      expect(testMailRes.json().message).toContain('admin-verify@example.com');
    } finally {
      await app.close();
    }
  });

  it('isolates admin CSRF cookie from user CSRF cookie so admin logout never breaks user sessions', async () => {
    const userToken = JwtUtil.sign(
      { sub: '99999999-9999-4999-8999-999999999999', email: 'dual@example.test' },
      config.jwtSecret,
      3600
    );
    const adminToken = JwtUtil.sign(
      { sub: config.superAdminId, email: 'admin@chatible.local', role: 'admin' },
      config.adminJwtSecret,
      3600
    );
    const userCsrf = 'user-csrf-token-isolated';
    const adminCsrf = 'admin-csrf-token-isolated';
    const combinedCookies = [
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(userToken)}`,
      `${CSRF_COOKIE_NAME}=${encodeURIComponent(userCsrf)}`,
      `${ADMIN_COOKIE_NAME}=${encodeURIComponent(adminToken)}`,
      `${ADMIN_CSRF_COOKIE_NAME}=${encodeURIComponent(adminCsrf)}`,
    ].join('; ');

    const mockAdminService = {
      markReportInReview: async (id: string) => ({ status: 'IN_REVIEW', reportId: id }),
      resolveReport: async (id: string) => ({ status: 'RESOLVED', reportId: id }),
    } as unknown as AdminService;

    const app = fastify();
    await app.register(fastifyCookie);
    registerCsrfOriginProtection(app);
    new AdminController(mockAdminService).registerRoutes(app);
    app.post('/api/v1/user-test/action', async (_req, reply) => reply.send({ ok: true }));

    try {
      // Admin route must reject the user CSRF token even if user cookies are also present
      const crossCsrfBlocked = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/reports/rep-1/resolve',
        headers: { cookie: combinedCookies, 'x-csrf-token': userCsrf },
        payload: { conclusion: 'DISMISSED' },
      });
      expect(crossCsrfBlocked.statusCode).toBe(403);

      // Admin IN_REVIEW transition succeeds with admin cookie + admin CSRF token
      const reviewRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/reports/rep-1/review',
        headers: { cookie: combinedCookies, 'x-csrf-token': adminCsrf },
      });
      expect(reviewRes.statusCode).toBe(200);
      expect(reviewRes.json()).toEqual({ status: 'IN_REVIEW', reportId: 'rep-1' });

      // Admin logout clears ONLY admin session + admin CSRF cookie, leaving user CSRF untouched
      const logoutRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/logout',
        headers: { cookie: combinedCookies, 'x-csrf-token': adminCsrf },
      });
      expect(logoutRes.statusCode).toBe(200);
      const clearedHeaders = Array.isArray(logoutRes.headers['set-cookie'])
        ? logoutRes.headers['set-cookie']
        : [String(logoutRes.headers['set-cookie'] || '')];
      expect(clearedHeaders.some((c) => c.startsWith(`${ADMIN_COOKIE_NAME}=;`) && c.includes('Max-Age=0'))).toBe(true);
      expect(clearedHeaders.some((c) => c.startsWith(`${ADMIN_CSRF_COOKIE_NAME}=;`) && c.includes('Max-Age=0'))).toBe(true);
      expect(clearedHeaders.some((c) => c.startsWith(`${CSRF_COOKIE_NAME}=`))).toBe(false);
      expect(clearedHeaders.some((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))).toBe(false);

      // User mutation continues succeeding with original user cookies
      const userAction = await app.inject({
        method: 'POST',
        url: '/api/v1/user-test/action',
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(userToken)}; ${CSRF_COOKIE_NAME}=${encodeURIComponent(userCsrf)}`,
          'x-csrf-token': userCsrf,
        },
      });
      expect(userAction.statusCode).toBe(200);
      expect(userAction.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });
});

import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { inArray } from 'drizzle-orm';
import { db } from '../database/index.js';
import { users } from '../database/schema/users.js';
import { JwtUtil } from '../auth/jwt.util.js';
import { config } from '../config/env.js';
import { SESSION_COOKIE_NAME } from '../auth/session-auth.util.js';
import { FriendsController } from '../friends/friends.controller.js';
import type { FriendsService } from '../friends/friends.service.js';
import { SafetyController } from '../safety/safety.controller.js';
import type { SafetyService } from '../safety/safety.service.js';
import type { SafetyNotificationService } from '../safety/notification.service.js';

describe('Centralized route auth & ApiError HTTP mapping', () => {
  it('returns 500 INTERNAL_ERROR (never 401) when FriendsService throws a database error on list routes', async () => {
    const activeUserId = randomUUID();
    await db.insert(users).values({
      id: activeUserId,
      email: `err-map-${activeUserId}@chatible.test`,
      status: 'ACTIVE',
    });

    const failingFriendsService = {
      listFriends: async () => {
        throw Object.assign(new Error('relation "profiles" timeout on host 10.0.1.9'), {
          name: 'PostgresError',
          code: '57P01',
        });
      },
      listIncomingRequests: async () => {
        throw new Error('SELECT * FROM secret_internal_table failed: syntax error');
      },
    } as unknown as FriendsService;

    const app = fastify({ logger: false });
    await app.register(fastifyCookie);
    new FriendsController(failingFriendsService).registerRoutes(app);
    await app.ready();

    try {
      const unauth = await app.inject({ method: 'GET', url: '/api/v1/friends' });
      expect(unauth.statusCode).toBe(401);
      expect(unauth.json().code).toBe('UNAUTHORIZED');

      const token = JwtUtil.sign({ sub: activeUserId, email: `err-map-${activeUserId}@chatible.test` }, config.jwtSecret);
      const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`;

      const listRes = await app.inject({
        method: 'GET',
        url: '/api/v1/friends',
        headers: { cookie },
      });
      expect(listRes.statusCode).toBe(500);
      expect(listRes.json().code).toBe('INTERNAL_ERROR');
      expect(listRes.json().error).toBe('Lỗi lấy danh sách bạn bè');
      expect(listRes.json().error).not.toContain('10.0.1.9');

      const reqsRes = await app.inject({
        method: 'GET',
        url: '/api/v1/friends/requests',
        headers: { cookie },
      });
      expect(reqsRes.statusCode).toBe(500);
      expect(reqsRes.json().code).toBe('INTERNAL_ERROR');
      expect(reqsRes.json().error).toBe('Lỗi lấy lời mời kết bạn');
      expect(reqsRes.json().error).not.toContain('secret_internal_table');
    } finally {
      await app.close();
      await db.delete(users).where(inArray(users.id, [activeUserId]));
    }
  });

  it('blocks RESTRICTED users on active-only endpoints (403 ACCOUNT_RESTRICTED) while allowing appeals and notifications', async () => {
    const restrictedUserId = randomUUID();
    await db.insert(users).values({
      id: restrictedUserId,
      email: `restricted-map-${restrictedUserId}@chatible.test`,
      status: 'RESTRICTED',
    });

    const mockFriends = { listFriends: async () => [] } as unknown as FriendsService;
    const mockSafety = {
      blockUser: async () => ({ status: 'BLOCKED' }),
      createAppeal: async () => ({ id: 'ap-1', status: 'PENDING' }),
      listUserAppeals: async () => [{ id: 'ap-1', status: 'PENDING' }],
    } as unknown as SafetyService;
    const mockNotifs = {
      listUserNotifications: async () => ({ notifications: [], unreadCount: 0 }),
      markRead: async () => ({ unreadCount: 0 }),
    } as unknown as SafetyNotificationService;

    const app = fastify({ logger: false });
    await app.register(fastifyCookie);
    new FriendsController(mockFriends).registerRoutes(app);
    new SafetyController(mockSafety, mockNotifs).registerRoutes(app);
    await app.ready();

    try {
      const token = JwtUtil.sign(
        { sub: restrictedUserId, email: `restricted-map-${restrictedUserId}@chatible.test` },
        config.jwtSecret
      );
      const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`;

      const friendsDenied = await app.inject({ method: 'GET', url: '/api/v1/friends', headers: { cookie } });
      expect(friendsDenied.statusCode).toBe(403);
      expect(friendsDenied.json().code).toBe('ACCOUNT_RESTRICTED');

      const blockDenied = await app.inject({
        method: 'POST',
        url: '/api/v1/blocks',
        headers: { cookie },
        payload: { targetUserId: randomUUID() },
      });
      expect(blockDenied.statusCode).toBe(403);
      expect(blockDenied.json().code).toBe('ACCOUNT_RESTRICTED');

      const appealCreate = await app.inject({
        method: 'POST',
        url: '/api/v1/appeals',
        headers: { cookie },
        payload: { reason: 'Tôi xin xem xét mở lại tài khoản' },
      });
      expect(appealCreate.statusCode).toBe(201);

      const appealsList = await app.inject({ method: 'GET', url: '/api/v1/appeals/me', headers: { cookie } });
      expect(appealsList.statusCode).toBe(200);

      const notifList = await app.inject({ method: 'GET', url: '/api/v1/notifications', headers: { cookie } });
      expect(notifList.statusCode).toBe(200);

      const notifRead = await app.inject({
        method: 'POST',
        url: '/api/v1/notifications/read',
        headers: { cookie },
        payload: {},
      });
      expect(notifRead.statusCode).toBe(200);
    } finally {
      await app.close();
      await db.delete(users).where(inArray(users.id, [restrictedUserId]));
    }
  });
});

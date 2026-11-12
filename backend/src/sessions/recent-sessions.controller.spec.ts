import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import fastify from 'fastify';
import { eq, or } from 'drizzle-orm';
import { config } from '../config/env.js';
import { JwtUtil } from '../auth/jwt.util.js';
import { db } from '../database/index.js';
import { chatSessions } from '../database/schema/sessions.js';
import { profiles, users } from '../database/schema/users.js';
import { RecentSessionsController } from './recent-sessions.controller.js';

async function seedUsers(ids: string[]) {
  await db.insert(users).values(ids.map((id) => ({ id, email: `recent-${id}@chatible.test` })));
  await db.insert(profiles).values(ids.map((userId, index) => ({
    userId,
    nickname: `Recent ${index + 1}`,
    gender: index === 1 ? 'FEMALE' : 'OTHER',
    birthDate: '1990-01-01',
    calculatedAge: 36,
  })));
}

async function removeFixtures(ids: string[]) {
  await db.delete(chatSessions).where(or(...ids.flatMap((id) => [eq(chatSessions.userAId, id), eq(chatSessions.userBId, id)])));
  await db.delete(users).where(or(...ids.map((id) => eq(users.id, id))));
}

describe('Recent random session history', () => {
  it('returns only unexpired ended random sessions and includes the eligible partner id', async () => {
    const [userId, partnerId] = [randomUUID(), randomUUID()];
    const eligibleId = randomUUID();
    const activeId = randomUUID();
    const friendId = randomUUID();
    const expiredId = randomUUID();
    const now = new Date();
    const app = fastify({ logger: false });
    await seedUsers([userId, partnerId]);
    await db.insert(chatSessions).values([
      {
        id: eligibleId,
        sessionType: 'RANDOM',
        userAId: userId,
        userBId: partnerId,
        status: 'ENDED',
        startedAt: new Date(now.getTime() - 60_000),
        endedAt: new Date(now.getTime() - 30_000),
        expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      },
      {
        id: activeId,
        sessionType: 'RANDOM',
        userAId: userId,
        userBId: partnerId,
        status: 'ACTIVE',
        expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      },
      {
        id: friendId,
        sessionType: 'FRIEND',
        userAId: userId,
        userBId: partnerId,
        status: 'ENDED',
        endedAt: new Date(now.getTime() - 30_000),
        expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      },
      {
        id: expiredId,
        sessionType: 'RANDOM',
        userAId: userId,
        userBId: partnerId,
        status: 'ENDED',
        endedAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000),
        expiresAt: new Date(now.getTime() - 1_000),
      },
    ]);

    try {
      new RecentSessionsController().registerRoutes(app);
      await app.ready();
      const token = JwtUtil.sign({ sub: userId, email: 'recent-user@example.test' }, config.jwtSecret);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions/recent',
        headers: { cookie: `chatible_session=${encodeURIComponent(token)}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().sessions).toMatchObject([{
        id: eligibleId,
        partnerId,
        partnerName: 'Recent 2',
        messagesCount: 0,
      }]);
      expect(response.json().sessions).toHaveLength(1);
    } finally {
      await app.close();
      await removeFixtures([userId, partnerId]);
    }
  });
});

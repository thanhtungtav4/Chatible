import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import fastify from 'fastify';
import { eq, or } from 'drizzle-orm';
import { config } from '../config/env.js';
import { JwtUtil } from '../auth/jwt.util.js';
import { db } from '../database/index.js';
import { chatSessions } from '../database/schema/sessions.js';
import { messages } from '../database/schema/messages.js';
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

  it('handles empty lists, missing partner profiles, and grouped message counts across multiple sessions', async () => {
    const [userId, knownPartnerId, noProfilePartnerId] = [randomUUID(), randomUUID(), randomUUID()];
    const s1 = randomUUID();
    const s2 = randomUUID();
    const now = new Date();
    const app = fastify({ logger: false });

    await seedUsers([userId, knownPartnerId]);
    // Insert a user WITHOUT a profile row to verify missing-profile fallback
    await db.insert(users).values({ id: noProfilePartnerId, email: `noprof-${noProfilePartnerId}@chatible.test` });

    try {
      new RecentSessionsController().registerRoutes(app);
      await app.ready();
      const token = JwtUtil.sign({ sub: userId, email: `recent-${userId}@chatible.test` }, config.jwtSecret);
      const cookie = `chatible_session=${encodeURIComponent(token)}`;

      // 1. Empty session list
      const emptyRes = await app.inject({ method: 'GET', url: '/api/v1/sessions/recent', headers: { cookie } });
      expect(emptyRes.statusCode).toBe(200);
      expect(emptyRes.json().sessions).toEqual([]);

      // 2. Multiple sessions (with 2 messages on s1, 0 messages on s2 with missing profile)
      await db.insert(chatSessions).values([
        {
          id: s1,
          sessionType: 'RANDOM',
          userAId: userId,
          userBId: knownPartnerId,
          status: 'ENDED',
          startedAt: new Date(now.getTime() - 120_000),
          endedAt: new Date(now.getTime() - 90_000),
          expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
        },
        {
          id: s2,
          sessionType: 'RANDOM',
          userAId: noProfilePartnerId,
          userBId: userId,
          status: 'ENDED',
          startedAt: new Date(now.getTime() - 60_000),
          endedAt: new Date(now.getTime() - 30_000),
          expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
        },
      ]);
      await db.insert(messages).values([
        {
          sessionId: s1,
          senderId: userId,
          encryptedDek: 'd1',
          iv: 'iv1',
          authTag: 'tag1',
          ciphertext: 'c1',
          messageType: 'TEXT',
          expiresAt: new Date(now.getTime() + 86_400_000),
        },
        {
          sessionId: s1,
          senderId: knownPartnerId,
          encryptedDek: 'd2',
          iv: 'iv2',
          authTag: 'tag2',
          ciphertext: 'c2',
          messageType: 'TEXT',
          expiresAt: new Date(now.getTime() + 86_400_000),
        },
      ]);

      const multiRes = await app.inject({ method: 'GET', url: '/api/v1/sessions/recent', headers: { cookie } });
      expect(multiRes.statusCode).toBe(200);
      expect(multiRes.json().sessions).toMatchObject([
        {
          id: s2,
          partnerId: noProfilePartnerId,
          partnerName: 'Người lạ',
          partnerGender: 'Nam',
          partnerAge: 20,
          messagesCount: 0,
        },
        {
          id: s1,
          partnerId: knownPartnerId,
          partnerName: 'Recent 2',
          partnerGender: 'Nữ',
          messagesCount: 2,
        },
      ]);
    } finally {
      await app.close();
      await db.delete(messages).where(or(eq(messages.sessionId, s1), eq(messages.sessionId, s2)));
      await removeFixtures([userId, knownPartnerId, noProfilePartnerId]);
    }
  });
});

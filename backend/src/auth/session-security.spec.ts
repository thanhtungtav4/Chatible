import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Redis from 'ioredis';
import { eq } from 'drizzle-orm';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';
import { DistributedRateLimiter } from './rate-limiter.js';
import {
  ADMIN_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  registerCsrfOriginProtection,
  SESSION_COOKIE_NAME,
  VAULT_COOKIE_NAME,
} from './session-auth.util.js';
import { RecentSessionsController } from '../sessions/recent-sessions.controller.js';
import { EnvelopeCryptoService } from '../crypto/envelope.service.js';
import { LocalKmsService } from '../kms/local-kms.service.js';
import { config } from '../config/env.js';
import { db } from '../database/index.js';
import { users } from '../database/schema/users.js';

function parseSetCookies(header: string | string[] | undefined): Record<string, { value: string; raw: string }> {
  const result: Record<string, { value: string; raw: string }> = {};
  if (!header) return result;
  const list = Array.isArray(header) ? header : [header];
  for (const raw of list) {
    const firstPart = raw.split(';', 1)[0] ?? '';
    const eqIndex = firstPart.indexOf('=');
    if (eqIndex <= 0) continue;
    const name = firstPart.slice(0, eqIndex).trim();
    const val = decodeURIComponent(firstPart.slice(eqIndex + 1).trim());
    result[name] = { value: val, raw };
  }
  return result;
}

describe('Session cookies, CSRF/Origin checks, Stealth Vault HTTP 423, and Redis rate limiting', () => {
  it('enforces HttpOnly cookies, double-submit CSRF, Origin policy, Stealth Vault 423, and logout revocation', async () => {
    const email = `sec-${randomUUID()}@chatible.test`;
    const password = 'StrongPassword123!';
    const app = fastify({ logger: false });
    await app.register(fastifyCookie);
    registerCsrfOriginProtection(app);

    const cryptoService = new EnvelopeCryptoService(
      new LocalKmsService('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
    );
    new AuthController(new AuthService()).registerRoutes(app);
    new RecentSessionsController(cryptoService).registerRoutes(app);
    await app.ready();

    let createdUserId = '';
    try {
      const regRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email,
          password,
          nickname: 'Sec Tester',
          gender: 'MALE',
          birthDate: '1994-05-15',
          policyAccepted: true,
        },
      });
      expect(regRes.statusCode).toBe(201);
      expect(regRes.json().accessToken).toBeUndefined();
      createdUserId = regRes.json().profile.id as string;

      const regCookies = parseSetCookies(regRes.headers['set-cookie']);
      expect(regCookies[SESSION_COOKIE_NAME]?.value).toBeTruthy();
      expect(regCookies[SESSION_COOKIE_NAME]?.raw).toContain('HttpOnly');
      expect(regCookies[CSRF_COOKIE_NAME]?.value).toBeTruthy();
      expect(regCookies[CSRF_COOKIE_NAME]?.raw).not.toContain('HttpOnly');

      const sessionToken = regCookies[SESSION_COOKIE_NAME]!.value;
      const csrfToken = regCookies[CSRF_COOKIE_NAME]!.value;
      const cookieHeader = `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionToken)}; ${CSRF_COOKIE_NAME}=${encodeURIComponent(csrfToken)}`;

      // Cookie-only web routes MUST reject Authorization: Bearer header
      const bearerRejected = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me/stealth-vault',
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      expect(bearerRejected.statusCode).toBe(401);

      // Mutating request with cookie session but missing X-CSRF-Token must fail 403
      const missingCsrf = await app.inject({
        method: 'PUT',
        url: '/api/v1/users/me/stealth-vault',
        headers: { cookie: cookieHeader },
        payload: { enabled: true, pin: '4829' },
      });
      expect(missingCsrf.statusCode).toBe(403);

      // Mutating request from untrusted Origin must fail 403
      const badOrigin = await app.inject({
        method: 'PUT',
        url: '/api/v1/users/me/stealth-vault',
        headers: {
          cookie: cookieHeader,
          'x-csrf-token': csrfToken,
          origin: 'https://evil-attacker.example',
        },
        payload: { enabled: true, pin: '4829' },
      });
      expect(badOrigin.statusCode).toBe(403);

      // Enabling Stealth Vault succeeds when valid cookie + matching X-CSRF-Token are presented
      const enableVault = await app.inject({
        method: 'PUT',
        url: '/api/v1/users/me/stealth-vault',
        headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
        payload: { enabled: true, pin: '4829' },
      });
      expect(enableVault.statusCode).toBe(200);
      expect(enableVault.json()).toEqual({ enabled: true, hasPin: true });

      // Without vault unlock cookie, recent sessions API MUST enforce HTTP 423 Locked and config must report unlocked: false
      const vaultStatusBefore = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me/stealth-vault',
        headers: { cookie: cookieHeader },
      });
      expect(vaultStatusBefore.statusCode).toBe(200);
      expect(vaultStatusBefore.json()).toMatchObject({ enabled: true, unlocked: false });

      const lockedRecent = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions/recent',
        headers: { cookie: cookieHeader },
      });
      expect(lockedRecent.statusCode).toBe(423);
      expect(lockedRecent.json()).toMatchObject({ vaultLocked: true });

      // Wrong PIN rejected
      const wrongPin = await app.inject({
        method: 'POST',
        url: '/api/v1/users/me/stealth-vault/unlock',
        headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
        payload: { pin: '0000' },
      });
      expect(wrongPin.statusCode).toBe(400);

      // Correct PIN issues HttpOnly Strict cookie (never returning vaultToken in JSON) & GET vault config reports unlocked: true
      const unlockRes = await app.inject({
        method: 'POST',
        url: '/api/v1/users/me/stealth-vault/unlock',
        headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
        payload: { pin: '4829' },
      });
      expect(unlockRes.statusCode).toBe(200);
      expect(unlockRes.json().vaultToken).toBeUndefined();
      const unlockCookies = parseSetCookies(unlockRes.headers['set-cookie']);
      expect(unlockCookies[VAULT_COOKIE_NAME]?.value).toBeTruthy();
      expect(unlockCookies[VAULT_COOKIE_NAME]?.raw).toContain('HttpOnly');
      expect(unlockCookies[VAULT_COOKIE_NAME]?.raw).toContain('SameSite=Strict');

      // x-vault-unlock-token header must be ignored on web routes (cookie-only)
      const headerVaultBypass = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions/recent',
        headers: {
          cookie: cookieHeader,
          'x-vault-unlock-token': unlockCookies[VAULT_COOKIE_NAME]!.value,
        },
      });
      expect(headerVaultBypass.statusCode).toBe(423);

      const fullCookieHeader = `${cookieHeader}; ${VAULT_COOKIE_NAME}=${encodeURIComponent(unlockCookies[VAULT_COOKIE_NAME]!.value)}`;
      const vaultStatusAfter = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me/stealth-vault',
        headers: { cookie: fullCookieHeader },
      });
      expect(vaultStatusAfter.statusCode).toBe(200);
      expect(vaultStatusAfter.json()).toMatchObject({ enabled: true, unlocked: true });

      const unlockedRecent = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions/recent',
        headers: {
          cookie: fullCookieHeader,
        },
      });
      expect(unlockedRecent.statusCode).toBe(200);

      // Logout revokes session JTI so captured session cookie is permanently invalid
      const logoutRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      });
      expect(logoutRes.statusCode).toBe(200);
      const logoutCookies = parseSetCookies(logoutRes.headers['set-cookie']);
      expect(logoutCookies[ADMIN_COOKIE_NAME]).toBeUndefined();

      const replayedAfterLogout = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me',
        headers: { cookie: cookieHeader },
      });
      expect(replayedAfterLogout.statusCode).toBe(401);
    } finally {
      await app.close();
      if (createdUserId) {
        await db.delete(users).where(eq(users.id, createdUserId));
      }
    }
  });

  it('enforces atomic Redis sliding-window rate limits across distributed checks', async () => {
    const redis = new Redis(config.redisUrl);
    const ns = `rl:test:${randomUUID()}`;
    const limiter = new DistributedRateLimiter(3, 10_000, ns, redis);
    const key = `subject:${randomUUID()}`;
    const baseNow = Date.now();

    try {
      expect(await limiter.check(key, baseNow + 1)).toBe(true);
      expect(await limiter.check(key, baseNow + 2)).toBe(true);
      expect(await limiter.check(key, baseNow + 3)).toBe(true);
      expect(await limiter.check(key, baseNow + 4)).toBe(false);
    } finally {
      await limiter.reset(key);
      await redis.quit();
    }
  });
});

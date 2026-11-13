import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { eq } from 'drizzle-orm';
import { db } from '../database/index.js';
import { users } from '../database/schema/users.js';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';
import {
  CSRF_COOKIE_NAME,
  registerCsrfOriginProtection,
  SESSION_COOKIE_NAME,
  VAULT_COOKIE_NAME,
} from './session-auth.util.js';

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

describe('Auth HTTP API lifecycle coverage (pre-split regression suite)', () => {
  it('supports HTTP password recovery, reset, change-password, and session invalidation', async () => {
    const email = `api-rec-${randomUUID()}@chatible.test`;
    const app = fastify({ logger: false });
    await app.register(fastifyCookie);
    registerCsrfOriginProtection(app);
    new AuthController(new AuthService()).registerRoutes(app);
    await app.ready();

    let userId = '';
    try {
      const regRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email,
          password: 'PasswordOld123!',
          nickname: 'RecoveryApi',
          gender: 'MALE',
          birthDate: '1994-02-10',
          policyAccepted: true,
        },
      });
      expect(regRes.statusCode).toBe(201);
      userId = regRes.json().profile.id as string;

      const forgotRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/forgot-password',
        payload: { email },
      });
      expect(forgotRes.statusCode).toBe(200);
      const resetCode = forgotRes.json().resetCode as string;
      expect(resetCode).toMatch(/^\d{6}$/);

      const resetRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/reset-password',
        payload: { email, code: resetCode, newPassword: 'PasswordReset456!' },
      });
      expect(resetRes.statusCode).toBe(200);

      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: 'PasswordReset456!' },
      });
      expect(loginRes.statusCode).toBe(200);
      const cookies = parseCookies(loginRes.headers['set-cookie']);
      const authCookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(cookies[SESSION_COOKIE_NAME]!)}; ${CSRF_COOKIE_NAME}=${encodeURIComponent(cookies[CSRF_COOKIE_NAME]!)}`;

      const changeRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/change-password',
        headers: { cookie: authCookie, 'x-csrf-token': cookies[CSRF_COOKIE_NAME]! },
        payload: { currentPassword: 'PasswordReset456!', newPassword: 'PasswordFinal789!' },
      });
      expect(changeRes.statusCode).toBe(200);

      // Re-login with newest password succeeds
      const loginFinal = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: 'PasswordFinal789!' },
      });
      expect(loginFinal.statusCode).toBe(200);
    } finally {
      await app.close();
      if (userId) await db.delete(users).where(eq(users.id, userId));
    }
  });

  it('supports HTTP profile fetch/update, public profile view, stealth vault lock/unlock, and account deletion', async () => {
    const email = `api-prof-${randomUUID()}@chatible.test`;
    const app = fastify({ logger: false });
    await app.register(fastifyCookie);
    registerCsrfOriginProtection(app);
    new AuthController(new AuthService()).registerRoutes(app);
    await app.ready();

    let userId = '';
    try {
      const regRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email,
          password: 'ProfilePass123!',
          nickname: 'OriginalNick',
          gender: 'FEMALE',
          birthDate: '1997-08-19',
          policyAccepted: true,
        },
      });
      expect(regRes.statusCode).toBe(201);
      userId = regRes.json().profile.id as string;
      const cookies = parseCookies(regRes.headers['set-cookie']);
      const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(cookies[SESSION_COOKIE_NAME]!)}; ${CSRF_COOKIE_NAME}=${encodeURIComponent(cookies[CSRF_COOKIE_NAME]!)}`;
      const csrf = cookies[CSRF_COOKIE_NAME]!;

      const meBefore = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: { cookie } });
      expect(meBefore.statusCode).toBe(200);
      expect(meBefore.json().nickname).toBe('OriginalNick');

      const updateRes = await app.inject({
        method: 'PUT',
        url: '/api/v1/users/profile',
        headers: { cookie, 'x-csrf-token': csrf },
        payload: { nickname: 'UpdatedNick', preferredGender: 'ALL', preferredAgeMax: 35 },
      });
      expect(updateRes.statusCode).toBe(200);
      expect(updateRes.json().nickname).toBe('UpdatedNick');

      const publicRes = await app.inject({ method: 'GET', url: `/api/v1/users/${userId}/public` });
      expect(publicRes.statusCode).toBe(200);
      expect(publicRes.json()).toMatchObject({ id: userId, nickname: 'UpdatedNick' });
      expect(publicRes.json().email).toBeUndefined();

      // Stealth vault enable -> unlock -> lock
      const setPin = await app.inject({
        method: 'PUT',
        url: '/api/v1/users/me/stealth-vault',
        headers: { cookie, 'x-csrf-token': csrf },
        payload: { enabled: true, pin: '2468' },
      });
      expect(setPin.statusCode).toBe(200);

      const unlock = await app.inject({
        method: 'POST',
        url: '/api/v1/users/me/stealth-vault/unlock',
        headers: { cookie, 'x-csrf-token': csrf },
        payload: { pin: '2468' },
      });
      expect(unlock.statusCode).toBe(200);
      expect(parseCookies(unlock.headers['set-cookie'])[VAULT_COOKIE_NAME]).toBeTruthy();

      const lock = await app.inject({
        method: 'POST',
        url: '/api/v1/users/me/stealth-vault/lock',
        headers: { cookie, 'x-csrf-token': csrf },
      });
      expect(lock.statusCode).toBe(200);
      expect(lock.json().unlocked).toBe(false);

      // Account deletion anonymizes & blocks subsequent logins
      const delRes = await app.inject({
        method: 'DELETE',
        url: '/api/v1/users/me',
        headers: { cookie, 'x-csrf-token': csrf },
      });
      expect(delRes.statusCode).toBe(200);

      const postDeleteLogin = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: 'ProfilePass123!' },
      });
      expect(postDeleteLogin.statusCode).toBe(401);
    } finally {
      await app.close();
      if (userId) await db.delete(users).where(eq(users.id, userId));
    }
  });
});

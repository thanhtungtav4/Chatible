import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import * as OTPAuth from 'otpauth';
import sharp from 'sharp';
import { eq, inArray } from 'drizzle-orm';
import { AdminService } from './admin.service.js';
import { AdminController } from './admin.controller.js';
import { AuditTrailService } from './audit.service.js';
import { EnvelopeCryptoService } from '../crypto/envelope.service.js';
import { LocalKmsService } from '../kms/local-kms.service.js';
import { MediaService, type MediaObjectStore } from '../media/media.service.js';
import { GroupsService } from '../groups/groups.service.js';
import { config } from '../config/env.js';
import { db } from '../database/index.js';
import { auditLogs } from '../database/schema/audit.js';
import { mediaAssets } from '../database/schema/media.js';
import { reportEvidence, reports } from '../database/schema/reports.js';
import { chatSessions } from '../database/schema/sessions.js';
import { systemSettings } from '../database/schema/settings.js';
import { profiles, users } from '../database/schema/users.js';
import {
  ADMIN_COOKIE_NAME,
  ADMIN_CSRF_COOKIE_NAME,
  registerCsrfOriginProtection,
} from '../auth/session-auth.util.js';

function parseSetCookies(header: string | string[] | undefined): Record<string, string> {
  const items = Array.isArray(header) ? header : header ? [header] : [];
  const out: Record<string, string> = {};
  for (const item of items) {
    const pair = item.split(';', 1)[0] || '';
    const idx = pair.indexOf('=');
    if (idx > 0) {
      out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
    }
  }
  return out;
}

class ChromeCdpClient {
  private ws!: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (val: unknown) => void; reject: (err: Error) => void }>();
  readonly consoleErrors: string[] = [];

  async connect(wsUrl: string): Promise<void> {
    this.ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket open timeout')), 10_000);
      this.ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP WebSocket connection error'));
      });
    });

    this.ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as {
          id?: number;
          method?: string;
          result?: unknown;
          error?: { message?: string };
          params?: { exceptionDetails?: { text?: string; exception?: { description?: string } }; type?: string; args?: Array<{ value?: string }> };
        };
        if (typeof msg.id === 'number') {
          const entry = this.pending.get(msg.id);
          if (entry) {
            this.pending.delete(msg.id);
            if (msg.error) {
              entry.reject(new Error(msg.error.message || 'CDP command failed'));
            } else {
              entry.resolve(msg.result);
            }
          }
          return;
        }
        if (msg.method === 'Runtime.exceptionThrown') {
          const text =
            msg.params?.exceptionDetails?.exception?.description ||
            msg.params?.exceptionDetails?.text ||
            'Uncaught browser exception';
          this.consoleErrors.push(text);
        }
      } catch {
        // Ignore malformed CDP frames
      }
    });

    await this.send('Page.enable');
    await this.send('Runtime.enable');
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout on ${method}`));
      }, 15_000);
      this.pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val as T);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const res = await this.send<{
      result?: { value?: T; description?: string; subtype?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'Runtime.evaluate exception'
      );
    }
    return res.result?.value as T;
  }

  async waitFor<T = unknown>(expression: string, timeoutMs = 10_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await this.evaluate<T>(expression);
      if (value) return value;
      await new Promise((r) => setTimeout(r, 80));
    }
    throw new Error(`Timed out waiting for browser condition: ${expression}; consoleErrors=${JSON.stringify(this.consoleErrors)}`);
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      // ignore close errors
    }
  }
}

describe('Admin hardening, MFA TOTP, media decrypt auditing, session pagination, and append-only audit logs', () => {
  it('enforces TOTP MFA, 15m HttpOnly Strict cookies, login rate limiting, logout JTI revocation, media audit, and immutable hash chains', async () => {
    const origAdminSecret = config.adminSecret;
    const origTotpEnv = config.adminTotpSecret;
    config.adminSecret = 'test-super-admin-secret-at-least-32-chars!!';
    config.adminTotpSecret = '';

    const prevMfaRows = await db
      .select()
      .from(systemSettings)
      .where(inArray(systemSettings.key, ['admin.mfa.enabled', 'admin.mfa.totp_secret']));

    const kms = new LocalKmsService('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
    const cryptoService = new EnvelopeCryptoService(kms);

    const objects = new Map<string, { body: Buffer; contentType: string }>();
    const storage: MediaObjectStore = {
      async presignPut(input) {
        return `https://storage.test/${input.key}`;
      },
      async exists(key) {
        return objects.has(key);
      },
      async head(key) {
        const obj = objects.get(key);
        return obj ? { exists: true, contentLength: obj.body.length, contentType: obj.contentType } : { exists: false };
      },
      async get(key) {
        const obj = objects.get(key);
        if (!obj) throw new Error('missing');
        return { body: obj.body, contentType: obj.contentType, contentLength: obj.body.length };
      },
      async delete(key) {
        objects.delete(key);
      },
    };

    const mediaService = new MediaService({ storage, kms });
    const adminService = new AdminService(cryptoService, config.superAdminId, undefined, mediaService);
    const groupsService = new GroupsService(cryptoService, config.superAdminId);
    const auditTrail = new AuditTrailService();

    const app = fastify({ logger: false });
    await app.register(fastifyCookie);
    registerCsrfOriginProtection(app);
    new AdminController(adminService, groupsService).registerRoutes(app);
    await app.ready();

    const [userA, userB] = [randomUUID(), randomUUID()];
    const sessionIds = [randomUUID(), randomUUID(), randomUUID()];
    let uploadedMediaId = '';

    try {
      await db.insert(users).values([
        { id: userA, email: `admin-hard-a-${userA}@chatible.test` },
        { id: userB, email: `admin-hard-b-${userB}@chatible.test` },
      ]);
      await db.insert(profiles).values([
        { userId: userA, nickname: 'AdminTestA', gender: 'MALE', birthDate: '1992-01-01', calculatedAge: 34 },
        { userId: userB, nickname: 'AdminTestB', gender: 'FEMALE', birthDate: '1995-01-01', calculatedAge: 31 },
      ]);
      await db.insert(chatSessions).values(
        sessionIds.map((id, idx) => ({
          id,
          sessionType: idx === 2 ? 'FRIEND' : 'RANDOM',
          userAId: userA,
          userBId: userB,
          status: 'ACTIVE',
          expiresAt: new Date(Date.now() + 86_400_000),
        }))
      );

      // Enable MFA via AdminService setup & TOTP confirmation
      const mfaSetup = adminService.generateAdminMfaSetup(config.superAdminId);
      const totp = new OTPAuth.TOTP({
        issuer: 'Chatible',
        label: config.superAdminId,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(mfaSetup.secretBase32),
      });
      await adminService.confirmEnableAdminMfa(
        config.superAdminId,
        mfaSetup.secretBase32,
        totp.generate(),
        '127.0.0.1'
      );

      // Login without TOTP fails 401
      const missingTotp = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth',
        payload: { secret: config.adminSecret },
      });
      expect(missingTotp.statusCode).toBe(401);

      // Login with valid secret + TOTP succeeds with 15m TTL and Strict HttpOnly + CSRF cookies (no accessToken in JSON)
      const okAuth = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth',
        payload: { secret: config.adminSecret, totpCode: totp.generate() },
      });
      expect(okAuth.statusCode).toBe(200);
      expect(okAuth.json().expiresIn).toBe(900);
      expect(okAuth.json().accessToken).toBeUndefined();
      const setCookies = parseSetCookies(okAuth.headers['set-cookie']);
      const adminCookie = setCookies[ADMIN_COOKIE_NAME] || '';
      const csrfCookie = setCookies[ADMIN_CSRF_COOKIE_NAME] || '';
      expect(adminCookie.length).toBeGreaterThan(20);
      expect(csrfCookie.length).toBeGreaterThan(20);
      const rawSetCookieHeader = Array.isArray(okAuth.headers['set-cookie'])
        ? okAuth.headers['set-cookie'].join('\n')
        : String(okAuth.headers['set-cookie'] || '');
      expect(rawSetCookieHeader).toContain(ADMIN_COOKIE_NAME);
      expect(rawSetCookieHeader).toContain('HttpOnly');
      expect(rawSetCookieHeader).toContain('SameSite=Strict');

      const cookieHeader = `${ADMIN_COOKIE_NAME}=${encodeURIComponent(adminCookie)}; ${ADMIN_CSRF_COOKIE_NAME}=${encodeURIComponent(csrfCookie)}`;

      // Strict cookie-only auth: Authorization Bearer header must be rejected
      const bearerRejected = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/stats',
        headers: { authorization: `Bearer ${adminCookie}` },
      });
      expect(bearerRejected.statusCode).toBe(401);

      // Disabling MFA via HTTP API is permanently blocked (403)
      const disableBlocked = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/mfa/disable',
        headers: { cookie: cookieHeader, 'x-csrf-token': csrfCookie },
        payload: {},
      });
      expect(disableBlocked.statusCode).toBe(403);

      // Upload real encrypted image and verify Admin can decrypt via audited endpoint
      await mediaService.setConsent(userB, sessionIds[0]!, true);
      const rawWebp = await sharp({
        create: { width: 24, height: 24, channels: 4, background: { r: 16, g: 185, b: 129, alpha: 1 } },
      })
        .webp()
        .toBuffer();
      const rawDek = randomBytes(32);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', rawDek, iv);
      const ciphertext = Buffer.concat([cipher.update(rawWebp), cipher.final()]);
      const tag = cipher.getAuthTag();

      const presigned = await mediaService.presignUpload(userA, {
        sessionId: sessionIds[0]!,
        recipientId: userB,
        contentType: 'image/webp',
        fileSize: ciphertext.length,
        mediaType: 'IMAGE',
        dek: rawDek.toString('base64'),
        iv: iv.toString('base64'),
        authTag: tag.toString('base64'),
      });
      uploadedMediaId = presigned.mediaId;
      const [assetRow] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, uploadedMediaId));
      objects.set(assetRow!.objectKey, { body: ciphertext, contentType: 'application/octet-stream' });
      await mediaService.completeUpload(userA, uploadedMediaId);

      const mediaView = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/media/${uploadedMediaId}/content`,
        headers: { cookie: cookieHeader },
      });
      expect(mediaView.statusCode).toBe(200);
      expect(mediaView.headers['content-type']).toBe('image/webp');
      expect(Buffer.from(mediaView.rawPayload).equals(rawWebp)).toBe(true);

      // Verify sessions pagination endpoint works accurately
      const paged = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/sessions?page=1&limit=2&search=AdminTestA',
        headers: { cookie: cookieHeader },
      });
      expect(paged.statusCode).toBe(200);
      expect(paged.json().sessions).toHaveLength(2);
      expect(paged.json().pagination.total).toBeGreaterThanOrEqual(3);
      expect(paged.json().pagination.totalPages).toBeGreaterThanOrEqual(2);

      // Verify hash chain validity & DB-level append-only immutability trigger
      const verification = await auditTrail.verifyAuditChain();
      expect(verification.valid).toBe(true);
      expect(verification.verifiedHashedEntries).toBeGreaterThanOrEqual(2);

      const [latestLog] = await db.select({ id: auditLogs.id }).from(auditLogs).limit(1);
      expect(latestLog).toBeTruthy();
      await expect(
        db.update(auditLogs).set({ action: 'TAMPERED' }).where(eq(auditLogs.id, latestLog!.id)).execute()
      ).rejects.toThrow();
      await expect(
        db.delete(auditLogs).where(eq(auditLogs.id, latestLog!.id)).execute()
      ).rejects.toThrow();

      // Mutating requests with admin cookie without X-CSRF-Token must be blocked (403)
      const logoutNoCsrf = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/logout',
        headers: { cookie: cookieHeader },
      });
      expect(logoutNoCsrf.statusCode).toBe(403);

      // Verify admin logout with X-CSRF-Token revokes the session cookie JWT immediately
      const logout = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/logout',
        headers: { cookie: cookieHeader, 'x-csrf-token': csrfCookie },
      });
      expect(logout.statusCode).toBe(200);

      const statsAfterLogout = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/stats',
        headers: { cookie: cookieHeader },
      });
      expect(statsAfterLogout.statusCode).toBe(401);

      // Rate-limit failed admin login attempts after 5 tries
      const rateLimitApp = fastify({ logger: false });
      new AdminController(adminService, groupsService).registerRoutes(rateLimitApp);
      await rateLimitApp.ready();
      try {
        for (let attempt = 0; attempt < 5; attempt++) {
          const fail = await rateLimitApp.inject({
            method: 'POST',
            url: '/api/v1/admin/auth',
            payload: { secret: 'wrong-secret' },
          });
          expect(fail.statusCode).toBe(401);
        }
        const blocked = await rateLimitApp.inject({
          method: 'POST',
          url: '/api/v1/admin/auth',
          payload: { secret: config.adminSecret, totpCode: totp.generate() },
        });
        expect(blocked.statusCode).toBe(429);
      } finally {
        await rateLimitApp.close();
      }
    } finally {
      config.adminSecret = origAdminSecret;
      config.adminTotpSecret = origTotpEnv;
      for (const row of prevMfaRows) {
        await db
          .insert(systemSettings)
          .values(row)
          .onConflictDoUpdate({
            target: systemSettings.key,
            set: { value: row.value, updatedAt: new Date() },
          });
      }
      if (prevMfaRows.length === 0) {
        await db
          .delete(systemSettings)
          .where(inArray(systemSettings.key, ['admin.mfa.enabled', 'admin.mfa.totp_secret']));
      }
      await app.close();
      if (uploadedMediaId) {
        await db.delete(mediaAssets).where(eq(mediaAssets.id, uploadedMediaId));
      }
      await db.delete(chatSessions).where(inArray(chatSessions.id, sessionIds));
      await db.delete(users).where(inArray(users.id, [userA, userB]));
    }
  });

  it('authenticates in real Chrome browser with HttpOnly + CSRF cookies, adjudicates report, and persists DB resolution', async () => {
    const chromeBin = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    expect(existsSync(chromeBin)).toBe(true);

    const origAdminSecret = config.adminSecret;
    const origTotpEnv = config.adminTotpSecret;
    const origCors = [...config.corsOrigins];
    config.adminSecret = 'chrome-e2e-super-admin-secret-32-chars!!';
    config.adminTotpSecret = '';

    const prevMfaRows = await db
      .select()
      .from(systemSettings)
      .where(inArray(systemSettings.key, ['admin.mfa.enabled', 'admin.mfa.totp_secret']));

    const kms = new LocalKmsService('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
    const cryptoService = new EnvelopeCryptoService(kms);
    const adminService = new AdminService(cryptoService, config.superAdminId);
    const groupsService = new GroupsService(cryptoService, config.superAdminId);

    const e2eApp = fastify({ logger: false });
    await e2eApp.register(fastifyCookie);
    await e2eApp.register(fastifyHelmet, { contentSecurityPolicy: false });
    registerCsrfOriginProtection(e2eApp);
    new AdminController(adminService, groupsService).registerRoutes(e2eApp);

    const [userA, userB] = [randomUUID(), randomUUID()];
    const sessionId = randomUUID();
    const reportId = randomUUID();
    const evidenceMsgId = randomUUID();
    const chromeProfileDir = mkdtempSync(path.join(os.tmpdir(), 'chatible-admin-chrome-'));
    let chromeProc: ReturnType<typeof spawn> | undefined;
    const cdp = new ChromeCdpClient();

    try {
      await db.insert(users).values([
        { id: userA, email: `chrome-e2e-a-${userA}@chatible.test` },
        { id: userB, email: `chrome-e2e-b-${userB}@chatible.test` },
      ]);
      await db.insert(profiles).values([
        { userId: userA, nickname: 'ChromeReporter', gender: 'MALE', birthDate: '1993-01-01', calculatedAge: 33 },
        { userId: userB, nickname: 'ChromeSuspect', gender: 'FEMALE', birthDate: '1994-01-01', calculatedAge: 32 },
      ]);
      await db.insert(chatSessions).values({
        id: sessionId,
        sessionType: 'RANDOM',
        userAId: userA,
        userBId: userB,
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 86_400_000),
      });

      const encryptedEvidence = await cryptoService.encrypt('Evidence text for Chrome E2E adjudication');
      await db.insert(reports).values({
        id: reportId,
        sessionId,
        reporterId: userA,
        reportedUserId: userB,
        reason: 'HARASSMENT',
        description: 'Chrome E2E browser flow check',
        priority: 'HIGH',
        status: 'OPEN',
      });
      await db.insert(reportEvidence).values({
        reportId,
        messageId: evidenceMsgId,
        frozenEncryptedDek: encryptedEvidence.encryptedDek,
        frozenCiphertext: encryptedEvidence.ciphertext,
        iv: encryptedEvidence.iv,
        authTag: encryptedEvidence.authTag,
        messageType: 'TEXT',
      });

      const mfaSetup = adminService.generateAdminMfaSetup(config.superAdminId);
      const totp = new OTPAuth.TOTP({
        issuer: 'Chatible',
        label: config.superAdminId,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(mfaSetup.secretBase32),
      });
      await adminService.confirmEnableAdminMfa(
        config.superAdminId,
        mfaSetup.secretBase32,
        totp.generate(),
        '127.0.0.1'
      );

      const baseUrl = await e2eApp.listen({ port: 0, host: '127.0.0.1' });
      config.corsOrigins.push(new URL(baseUrl).origin);

      const devtoolsPort = await new Promise<number>((resolve, reject) => {
        let stderrText = '';
        chromeProc = spawn(
          chromeBin,
          [
            '--headless=new',
            '--no-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--remote-debugging-port=0',
            `--user-data-dir=${chromeProfileDir}`,
            'about:blank',
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] }
        );
        const timer = setTimeout(() => {
          reject(new Error(`Chrome DevTools did not start in time. stderr=${stderrText}`));
        }, 15_000);
        chromeProc.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        chromeProc.stderr?.on('data', (chunk: Buffer) => {
          stderrText += chunk.toString('utf8');
          const match = stderrText.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
          if (match) {
            clearTimeout(timer);
            resolve(Number.parseInt(match[1]!, 10));
          }
        });
      });

      const targetsRes = await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`);
      const targets = (await targetsRes.json()) as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
      const pageTarget = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      expect(pageTarget?.webSocketDebuggerUrl).toBeTruthy();

      await cdp.connect(pageTarget!.webSocketDebuggerUrl!);
      await cdp.send('Page.navigate', { url: `${baseUrl}/admin-auth` });

      await cdp.waitFor(
        `document.getElementById('admin-login-modal')?.style.display === 'flex'`,
        12_000
      );
      await cdp.waitFor(
        `getComputedStyle(document.getElementById('admin-login-totp-group')).display !== 'none'`,
        8_000
      );

      const disableBtnMissing = await cdp.evaluate<boolean>(
        `document.getElementById('btn-mfa-disable') === null`
      );
      expect(disableBtnMissing).toBe(true);

      const currentOtp = totp.generate();
      await cdp.evaluate(`(() => {
        const secretEl = document.getElementById('admin-login-secret');
        const totpEl = document.getElementById('admin-login-totp');
        const formEl = document.getElementById('admin-login-form');
        secretEl.value = ${JSON.stringify(config.adminSecret)};
        totpEl.value = ${JSON.stringify(currentOtp)};
        formEl.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      })()`);

      await cdp.waitFor(
        `document.getElementById('admin-login-modal')?.style.display === 'none'`,
        10_000
      );

      const cookieState = await cdp.evaluate<{ hasCsrf: boolean; hidesAdminHttpOnly: boolean }>(
        `(() => ({
          hasCsrf: document.cookie.includes(${JSON.stringify(`${ADMIN_CSRF_COOKIE_NAME}=`)}),
          hidesAdminHttpOnly: !document.cookie.includes(${JSON.stringify(`${ADMIN_COOKIE_NAME}=`)})
        }))()`
      );
      expect(cookieState).toEqual({ hasCsrf: true, hidesAdminHttpOnly: true });

      await cdp.evaluate(`document.querySelector('[data-tab="tab-reports"]').click()`);
      const reportBtnSelector = `[data-report-id="${reportId}"]`;
      await cdp.waitFor(`document.querySelector(${JSON.stringify(reportBtnSelector)}) !== null`, 10_000);
      await cdp.evaluate(`document.querySelector(${JSON.stringify(reportBtnSelector)}).click()`);

      await cdp.waitFor(
        `document.getElementById('transcript-modal')?.style.display === 'flex' && document.getElementById('modal-resolve-btn') !== null`,
        10_000
      );

      const modalHasEvidence = await cdp.evaluate<boolean>(
        `document.getElementById('transcript-modal')?.innerText.includes('Evidence text for Chrome E2E adjudication')`
      );
      expect(modalHasEvidence).toBe(true);

      await cdp.evaluate(`(() => {
        const noteEl = document.getElementById('modal-moderation-note');
        noteEl.value = 'Chrome E2E verified action';
        noteEl.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('modal-resolve-btn').click();
      })()`);

      await cdp.waitFor(
        `document.getElementById('transcript-modal')?.style.display === 'none'`,
        10_000
      );

      const [resolvedReport] = await db.select().from(reports).where(eq(reports.id, reportId));
      expect(resolvedReport?.status).toBe('RESOLVED');
      expect(resolvedReport?.resolutionConclusion).toBe('ACTION_TAKEN');
      expect(resolvedReport?.adminNote).toBe('Chrome E2E verified action');
      expect(cdp.consoleErrors).toEqual([]);
    } finally {
      cdp.close();
      if (chromeProc && !chromeProc.killed) {
        chromeProc.kill('SIGKILL');
      }
      rmSync(chromeProfileDir, { recursive: true, force: true });
      await e2eApp.close();
      config.corsOrigins.splice(0, config.corsOrigins.length, ...origCors);
      config.adminSecret = origAdminSecret;
      config.adminTotpSecret = origTotpEnv;
      for (const row of prevMfaRows) {
        await db
          .insert(systemSettings)
          .values(row)
          .onConflictDoUpdate({
            target: systemSettings.key,
            set: { value: row.value, updatedAt: new Date() },
          });
      }
      if (prevMfaRows.length === 0) {
        await db
          .delete(systemSettings)
          .where(inArray(systemSettings.key, ['admin.mfa.enabled', 'admin.mfa.totp_secret']));
      }
      await db.delete(reports).where(eq(reports.id, reportId));
      await db.delete(chatSessions).where(eq(chatSessions.id, sessionId));
      await db.delete(users).where(inArray(users.id, [userA, userB]));
    }
  }, 25_000);
});

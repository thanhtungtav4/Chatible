import crypto, { timingSafeEqual } from 'node:crypto';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type Redis from 'ioredis';
import { AdminService } from './admin.service.js';
import { config } from '../config/env.js';
import { JwtUtil } from '../auth/jwt.util.js';
import type { SmtpConfigOverride } from '../mail/mail.service.js';
import { DistributedRateLimiter } from '../auth/rate-limiter.js';
import {
  ADMIN_COOKIE_NAME,
  clearAdminSessionCookie,
  getRequestCookies,
  setAdminSessionCookie,
  tokenRevocationStore,
} from '../auth/session-auth.util.js';
import type { CommunityRoomType, GroupsService } from '../groups/groups.service.js';
import { renderAdminDashboardHtml } from './admin-console.view.js';

export class AdminController {
  private readonly adminAuthLimiter = new DistributedRateLimiter(5, 15 * 60_000, 'rl:admin:auth');
  private userRevoker?: (userId: string) => Promise<void>;

  constructor(
    private readonly adminService: AdminService,
    private readonly groupsService?: GroupsService
  ) {}

  setRedis(redis: Redis): void {
    this.adminAuthLimiter.setRedis(redis);
  }

  setUserRevoker(revokeUser: (userId: string) => Promise<void>): void {
    this.userRevoker = revokeUser;
  }

  private verifyAdminSecret(candidate: string): boolean {
    const secrets = [config.adminSecret, config.adminPassword].filter(Boolean);
    if (!candidate || secrets.length === 0) return false;
    const candidateBuf = Buffer.from(candidate);
    for (const sec of secrets) {
      const secretBuf = Buffer.from(sec);
      if (secretBuf.length === candidateBuf.length && timingSafeEqual(secretBuf, candidateBuf)) {
        return true;
      }
    }
    return false;
  }

  private async verifyAdminCredentials(
    username?: string,
    password?: string,
    secret?: string
  ): Promise<boolean> {
    if (typeof this.adminService.verifyAdminCredentials === 'function') {
      return await this.adminService.verifyAdminCredentials(username, password, secret);
    }
    const candidate = secret || password || '';
    if (username && password) {
      const expectedUser = config.adminUsername || 'admin';
      if (username.trim().toLowerCase() !== expectedUser.toLowerCase()) return false;
      return this.verifyAdminSecret(candidate);
    }
    return this.verifyAdminSecret(candidate);
  }

  private extractAdminToken(req: FastifyRequest): string | null {
    const cookies = getRequestCookies(req);
    return cookies[ADMIN_COOKIE_NAME] || null;
  }

  private async validateAdminAuth(req: FastifyRequest): Promise<boolean> {
    const token = this.extractAdminToken(req);
    if (!token) return false;

    try {
      const payload = JwtUtil.verify(token, config.adminJwtSecret);
      if (payload.role !== 'admin' || payload.sub !== config.superAdminId) return false;
      if (await tokenRevocationStore.isTokenRevoked(payload)) return false;
      return true;
    } catch {
      return false;
    }
  }

  private async verifyGoogleIdToken(idToken: string): Promise<{ sub: string; email: string; name?: string }> {
    const activeClientId = await this.adminService.getGoogleClientId();
    if (!activeClientId) {
      throw new Error('Google OAuth chưa được cấu hình.');
    }
    const tokenUrl = new URL('https://oauth2.googleapis.com/tokeninfo');
    tokenUrl.searchParams.set('id_token', idToken);
    const res = await fetch(tokenUrl);
    if (!res.ok) {
      throw new Error('Google ID Token không hợp lệ hoặc đã hết hạn.');
    }
    const data = (await res.json()) as {
      sub?: string;
      email?: string;
      name?: string;
      aud?: string;
      iss?: string;
      exp?: string;
      email_verified?: string | boolean;
    };
    const expiresAt = Number(data.exp);
    const validIssuer = data.iss === 'accounts.google.com' || data.iss === 'https://accounts.google.com';
    const emailVerified = data.email_verified === true || data.email_verified === 'true';
    if (
      !data.sub ||
      !data.email ||
      data.aud !== activeClientId ||
      !validIssuer ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now() / 1000 ||
      !emailVerified
    ) {
      throw new Error('Google ID Token thiếu claim hợp lệ hoặc không dành cho ứng dụng này.');
    }
    return {
      sub: data.sub,
      email: data.email.toLowerCase().trim(),
      name: data.name,
    };
  }

  registerRoutes(app: FastifyInstance) {
    // Public Admin Auth capability status
    app.get('/api/v1/admin/auth/status', async (_req, reply) => {
      try {
        const mfa = await this.adminService.getAdminMfaStatus();
        const authSettings = await this.adminService.getAdminAuthSettings();
        const googleClientId = await this.adminService.getGoogleClientId();
        return reply.send({
          mfaRequired: mfa.enabled,
          defaultUsername: authSettings.username,
          googleAuthEnabled: Boolean(googleClientId),
          googleClientId,
          linkedGoogleEmail: authSettings.googleEmail,
        });
      } catch {
        return reply.send({
          mfaRequired: Boolean(config.adminTotpSecret),
          defaultUsername: config.adminUsername || 'admin',
          googleAuthEnabled: Boolean(config.googleClientId),
          googleClientId: config.googleClientId || '',
          linkedGoogleEmail: config.adminGoogleEmail || 'nguyenthanhtung74119@gmail.com',
        });
      }
    });

    // Exchange administrator credentials (username+password OR secret token + optional TOTP) for 15m JWT + HttpOnly Strict cookie.
    app.post(
      '/api/v1/admin/auth',
      async (
        req: FastifyRequest<{
          Body: {
            username?: string;
            password?: string;
            secret?: string;
            totpCode?: string;
          };
        }>,
        reply: FastifyReply
      ) => {
        const clientIp = req.ip || '127.0.0.1';
        if (!(await this.adminAuthLimiter.check(`admin_login:${clientIp}`))) {
          return reply.status(429).send({ error: 'Quá nhiều lần đăng nhập quản trị thất bại. Vui lòng thử lại sau 15 phút.' });
        }

        const valid = await this.verifyAdminCredentials(
          req.body?.username,
          req.body?.password,
          req.body?.secret
        );
        if (!valid) {
          return reply.status(401).send({ error: 'Tên đăng nhập hoặc mật khẩu quản trị không chính xác.' });
        }

        const mfaEnabled = typeof this.adminService.getAdminMfaStatus === 'function'
          ? (await this.adminService.getAdminMfaStatus()).enabled
          : Boolean(config.adminTotpSecret);

        if (mfaEnabled && typeof this.adminService.verifyAdminTotp === 'function') {
          const totpValid = await this.adminService.verifyAdminTotp(req.body?.totpCode);
          if (!totpValid) {
            return reply.status(401).send({ error: 'Mã xác thực 2 bước (TOTP 6 số) không chính xác hoặc bị thiếu.' });
          }
        }

        const ttlSeconds = 900; // 15 minutes
        const accessToken = JwtUtil.sign(
          { sub: config.superAdminId, email: 'admin@chatible.local', role: 'admin' },
          config.adminJwtSecret,
          ttlSeconds
        );
        setAdminSessionCookie(reply, accessToken, ttlSeconds);
        return reply.status(200).send({ ok: true, expiresIn: ttlSeconds });
      }
    );

    // Google Sign-In for Admin (/admin-auth)
    app.post(
      '/api/v1/admin/auth/google',
      async (req: FastifyRequest<{ Body: { idToken?: string } }>, reply: FastifyReply) => {
        const clientIp = req.ip || '127.0.0.1';
        if (!(await this.adminAuthLimiter.check(`admin_google:${clientIp}`))) {
          return reply.status(429).send({ error: 'Quá nhiều lần thử đăng nhập quản trị. Vui lòng thử lại sau 15 phút.' });
        }

        const idToken = req.body?.idToken?.trim();
        if (!idToken) {
          return reply.status(400).send({ error: 'Google ID Token bị thiếu.' });
        }

        let verifiedUser: { sub: string; email: string; name?: string };
        try {
          verifiedUser = await this.verifyGoogleIdToken(idToken);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Xác thực Google ID Token thất bại.';
          return reply.status(401).send({ error: msg });
        }

        const isAuthorized = await this.adminService.verifyAdminGoogleEmail(verifiedUser.email);
        if (!isAuthorized) {
          return reply.status(403).send({
            error: `Tài khoản Google (${verifiedUser.email}) chưa được liên kết với quyền Super Admin.`,
          });
        }

        const ttlSeconds = 900; // 15 minutes
        const accessToken = JwtUtil.sign(
          { sub: config.superAdminId, email: verifiedUser.email, role: 'admin' },
          config.adminJwtSecret,
          ttlSeconds
        );
        setAdminSessionCookie(reply, accessToken, ttlSeconds);
        return reply.status(200).send({ ok: true, email: verifiedUser.email, expiresIn: ttlSeconds });
      }
    );

    // Admin logout (revokes JTI & clears HttpOnly Strict cookie + Admin CSRF cookie)
    app.post('/api/v1/admin/logout', async (req, reply) => {
      const token = this.extractAdminToken(req);
      if (token) {
        try {
          const claims = JwtUtil.verify(token, config.adminJwtSecret);
          if (claims.jti) {
            await tokenRevocationStore.revokeJti(claims.jti, 900);
          }
        } catch {
          // ignore
        }
      }
      clearAdminSessionCookie(reply);
      return reply.status(200).send({ success: true });
    });

    // 1. API: Thống kê tổng quan
    app.get('/api/v1/admin/stats', async (req, reply) => {
      if (!(await this.validateAdminAuth(req))) {
        return reply.status(401).send({ error: 'Yêu cầu mã khóa quản trị viên hợp lệ (Admin Token Required).' });
      }
      const stats = await this.adminService.getStats();
      return reply.send(stats);
    });

    // 2. API: Danh sách báo cáo vi phạm
    app.get('/api/v1/admin/reports', async (req, reply) => {
      if (!(await this.validateAdminAuth(req))) {
        return reply.status(401).send({ error: 'Yêu cầu mã khóa quản trị viên hợp lệ (Admin Token Required).' });
      }
      const list = await this.adminService.listReports();
      return reply.send(list);
    });

    // 3. API: Super Admin mở bằng chứng (Bắt buộc ghi AuditLog)
    app.get(
      '/api/v1/admin/reports/:id/adjudicate',
      async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
        if (!(await this.validateAdminAuth(req))) {
          return reply.status(401).send({ error: 'Yêu cầu mã khóa quản trị viên hợp lệ (Admin Token Required).' });
        }
        try {
          const result = await this.adminService.adjudicateReport(req.params.id, config.superAdminId, req.ip);
          return reply.send(result);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Không thể mở bằng chứng.';
          const statusCode = msg.includes('không tồn tại') ? 404 : 500;
          return reply.status(statusCode).send({ error: msg });
        }
      }
    );

    app.post(
      '/api/v1/admin/reports/:id/review',
      async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
        if (!(await this.validateAdminAuth(req))) {
          return reply.status(401).send({ error: 'Yêu cầu JWT quản trị hợp lệ.' });
        }
        try {
          const result = await this.adminService.markReportInReview(req.params.id, config.superAdminId, req.ip);
          return reply.send(result);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Không thể chuyển trạng thái báo cáo.';
          const statusCode = msg === 'Báo cáo không tồn tại.' ? 404 : msg.includes('đã được') ? 409 : 500;
          return reply.status(statusCode).send({ error: msg });
        }
      }
    );

    app.post(
      '/api/v1/admin/reports/:id/resolve',
      async (
        req: FastifyRequest<{
          Params: { id: string };
          Body?: {
            conclusion?: 'ACTION_TAKEN' | 'DISMISSED' | 'NO_VIOLATION';
            adminNote?: string;
            restrictUser?: boolean;
          };
        }>,
        reply
      ) => {
        if (!(await this.validateAdminAuth(req))) {
          return reply.status(401).send({ error: 'Yêu cầu JWT quản trị hợp lệ.' });
        }
        try {
          const result = await this.adminService.resolveReport(
            req.params.id,
            config.superAdminId,
            req.ip,
            req.body
          );
          if (req.body?.restrictUser) {
            const report = (await this.adminService.listReports()).find((r) => r.id === req.params.id);
            if (report?.reportedUserId) {
              await this.userRevoker?.(report.reportedUserId);
            }
          }
          return reply.send(result);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Không thể đóng báo cáo.';
          const statusCode = msg === 'Báo cáo không tồn tại.' ? 404 : msg === 'Báo cáo đã được đóng.' ? 409 : 500;
          return reply.status(statusCode).send({ error: msg });
        }
      }
    );

    // 4. API: Danh sách phiên chat có tìm kiếm & phân trang
    app.get(
      '/api/v1/admin/sessions',
      async (
        req: FastifyRequest<{
          Querystring: { page?: string; limit?: string; search?: string; type?: string; status?: string };
        }>,
        reply
      ) => {
        if (!(await this.validateAdminAuth(req))) {
          return reply.status(401).send({ error: 'Yêu cầu mã khóa quản trị viên hợp lệ (Admin Token Required).' });
        }
        const q = req.query || {};
        const result = await this.adminService.listSessions({
          page: q.page ? Number.parseInt(q.page, 10) : 1,
          limit: q.limit ? Number.parseInt(q.limit, 10) : 25,
          search: q.search,
          type: q.type,
          status: q.status,
        });
        return reply.send(result);
      }
    );

    // 5. API: Super Admin mở xem transcript phiên chat (Bắt buộc ghi AuditLog)
    app.get(
      '/api/v1/admin/sessions/:id/transcript',
      async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
        if (!(await this.validateAdminAuth(req))) {
          return reply.status(401).send({ error: 'Yêu cầu mã khóa quản trị viên hợp lệ (Admin Token Required).' });
        }
        try {
          const result = await this.adminService.openSessionTranscript(req.params.id, config.superAdminId, req.ip);
          return reply.send(result);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Lỗi giải mã';
          const statusCode = msg.includes('không tồn tại') ? 404 : 500;
          return reply.status(statusCode).send({ error: msg });
        }
      }
    );

    // 5b. API: Super Admin giải mã xem đầy đủ media còn giữ (kể cả đã thu hồi), bắt buộc ghi AuditLog
    app.get(
      '/api/v1/admin/media/:mediaId/content',
      async (req: FastifyRequest<{ Params: { mediaId: string } }>, reply) => {
        if (!(await this.validateAdminAuth(req))) {
          return reply.status(401).send({ error: 'Yêu cầu mã khóa quản trị viên hợp lệ (Admin Token Required).' });
        }
        try {
          const res = await this.adminService.openAdminMedia(req.params.mediaId, config.superAdminId, req.ip);
          return reply
            .header('Content-Type', res.contentType)
            .header('Content-Length', res.fileSize)
            .header('Cache-Control', 'private, no-store')
            .header('Referrer-Policy', 'no-referrer')
            .header('X-Content-Type-Options', 'nosniff')
            .header('X-Admin-Media-Adult', String(res.isAdult))
            .header('X-Admin-Media-Revoked', String(Boolean(res.revokedAt)))
            .send(res.stream);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Không thể giải mã media.';
          const statusCode = msg.includes('Không tìm thấy') ? 404 : 400;
          return reply.status(statusCode).send({ error: msg });
        }
      }
    );

    // 6. API: Nhật ký kiểm toán AuditLog + Kiểm tra Hash Chain + Export bất biến
    app.get('/api/v1/admin/audit-logs', async (req, reply) => {
      if (!(await this.validateAdminAuth(req))) {
        return reply.status(401).send({ error: 'Yêu cầu mã khóa quản trị viên hợp lệ (Admin Token Required).' });
      }
      const logs = await this.adminService.listAuditLogs();
      return reply.send(logs);
    });

    app.get('/api/v1/admin/audit-logs/verify', async (req, reply) => {
      if (!(await this.validateAdminAuth(req))) {
        return reply.status(401).send({ error: 'Yêu cầu mã khóa quản trị viên hợp lệ.' });
      }
      const verification = await this.adminService.verifyAuditChain();
      return reply.send(verification);
    });

    app.get('/api/v1/admin/audit-logs/export', async (req, reply) => {
      if (!(await this.validateAdminAuth(req))) {
        return reply.status(401).send({ error: 'Yêu cầu mã khóa quản trị viên hợp lệ.' });
      }
      const snapshot = await this.adminService.exportAuditLogs();
      reply
        .header('Content-Type', 'application/x-ndjson; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="chatible-audit-${Date.now()}.jsonl"`)
        .header('X-Audit-Sha256', snapshot.sha256);
      if (snapshot.uploadedObjectKey) {
        reply.header('X-Audit-Uploaded-Key', snapshot.uploadedObjectKey);
      }
      return reply.send(snapshot.jsonl);
    });

    // API: Đình chỉ / Khóa tài khoản người dùng vi phạm
    app.post(
      '/api/v1/admin/users/:id/restrict',
      async (req: FastifyRequest<{ Params: { id: string }; Body: { reason?: string } }>, reply) => {
        if (!(await this.validateAdminAuth(req))) {
          return reply.status(401).send({ error: 'Yêu cầu mã khóa quản trị viên hợp lệ (Admin Token Required).' });
        }
        try {
          const res = await this.adminService.restrictUser(
            req.params.id,
            config.superAdminId,
            req.body?.reason || 'Vi phạm chính sách',
            req.ip
          );
          await this.userRevoker?.(req.params.id);
          return reply.send(res);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Lỗi khóa tài khoản';
          const statusCode = msg.includes('Không tìm thấy') ? 404 : 500;
          return reply.status(statusCode).send({ error: msg });
        }
      }
    );

    // 7. API: Danh sách & Xử lý Khiếu nại
    app.get('/api/v1/admin/appeals', async (req, reply) => {
      if (!(await this.validateAdminAuth(req))) {
        return reply.status(401).send({ error: 'Yêu cầu mã khóa quản trị viên hợp lệ (Admin Token Required).' });
      }
      const list = await this.adminService.listAppeals();
      return reply.send(list);
    });

    app.post(
      '/api/v1/admin/appeals/:id/resolve',
      async (
        req: FastifyRequest<{
          Params: { id: string };
          Body: { decision: 'APPROVE' | 'REJECT'; adminNote?: string };
        }>,
        reply
      ) => {
        if (!(await this.validateAdminAuth(req))) {
          return reply.status(401).send({ error: 'Yêu cầu mã khóa quản trị viên hợp lệ (Admin Token Required).' });
        }
        const decision = req.body?.decision;
        if (decision !== 'APPROVE' && decision !== 'REJECT') {
          return reply.status(400).send({ error: 'Quyết định phải là APPROVE hoặc REJECT.' });
        }
        try {
          const result = await this.adminService.resolveAppeal(
            req.params.id,
            config.superAdminId,
            decision,
            req.body?.adminNote,
            req.ip
          );
          return reply.send(result);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Lỗi xử lý đơn khiếu nại';
          const statusCode = msg.includes('không tồn tại') ? 404 : 400;
          return reply.status(statusCode).send({ error: msg });
        }
      }
    );

    // 9. API: Cấu hình hệ thống, Test Mail & Admin MFA
    app.get('/api/v1/admin/settings', async (req, reply) => {
      if (!(await this.validateAdminAuth(req))) {
        return reply.status(401).send({ error: 'Yêu cầu mã khóa quản trị viên hợp lệ (Admin Token Required).' });
      }
      const settings = await this.adminService.getSettings();
      return reply.send(settings);
    });

    app.put(
      '/api/v1/admin/settings',
      async (
        req: FastifyRequest<{
          Body: { settings?: Record<string, string> };
        }>,
        reply
      ) => {
        if (!(await this.validateAdminAuth(req))) {
          return reply.status(401).send({ error: 'Yêu cầu mã khóa quản trị viên hợp lệ (Admin Token Required).' });
        }
        try {
          const result = await this.adminService.updateSettings(
            config.superAdminId,
            req.body?.settings || {},
            req.ip
          );
          return reply.send(result);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Lỗi cập nhật cấu hình';
          return reply.status(400).send({ error: msg });
        }
      }
    );

    app.post(
      '/api/v1/admin/settings/test-email',
      async (
        req: FastifyRequest<{
          Body: {
            toEmail?: string;
            smtpConfig?: SmtpConfigOverride;
          };
        }>,
        reply
      ) => {
        if (!(await this.validateAdminAuth(req))) {
          return reply.status(401).send({ error: 'Yêu cầu mã khóa quản trị viên hợp lệ (Admin Token Required).' });
        }
        try {
          const result = await this.adminService.sendTestEmail(
            config.superAdminId,
            req.body?.toEmail || '',
            req.body?.smtpConfig,
            req.ip
          );
          return reply.send(result);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Gửi email thử nghiệm thất bại.';
          return reply.status(400).send({ error: msg });
        }
      }
    );

    // Admin 2FA MFA Management
    app.get('/api/v1/admin/mfa/status', async (req, reply) => {
      if (!(await this.validateAdminAuth(req))) {
        return reply.status(401).send({ error: 'Yêu cầu JWT quản trị hợp lệ.' });
      }
      return reply.send(await this.adminService.getAdminMfaStatus());
    });

    app.post('/api/v1/admin/mfa/setup', async (req, reply) => {
      if (!(await this.validateAdminAuth(req))) {
        return reply.status(401).send({ error: 'Yêu cầu JWT quản trị hợp lệ.' });
      }
      return reply.send(this.adminService.generateAdminMfaSetup(config.superAdminId));
    });

    app.post(
      '/api/v1/admin/mfa/enable',
      async (req: FastifyRequest<{ Body: { secretBase32?: string; code?: string } }>, reply) => {
        if (!(await this.validateAdminAuth(req))) {
          return reply.status(401).send({ error: 'Yêu cầu JWT quản trị hợp lệ.' });
        }
        try {
          const res = await this.adminService.confirmEnableAdminMfa(
            config.superAdminId,
            req.body?.secretBase32 || '',
            req.body?.code || '',
            req.ip
          );
          return reply.send(res);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Không thể bật MFA.';
          return reply.status(400).send({ error: msg });
        }
      }
    );

    app.post(
      '/api/v1/admin/mfa/disable',
      async (req, reply) => {
        if (!(await this.validateAdminAuth(req))) {
          return reply.status(401).send({ error: 'Yêu cầu xác thực quản trị viên hợp lệ.' });
        }
        return reply.status(403).send({
          error: 'MFA Super Admin là bắt buộc và không thể tắt qua giao diện hoặc API.',
        });
      }
    );

    // 10. API: Quản lý Nhóm & Kênh Cộng Đồng từ Admin Deck
    app.get('/api/v1/admin/groups', async (req, reply) => {
      if (!(await this.validateAdminAuth(req))) {
        return reply.status(401).send({ error: 'Yêu cầu JWT quản trị hợp lệ.' });
      }
      if (!this.groupsService) return reply.send({ rooms: [] });
      const rooms = await this.groupsService.listRooms(config.superAdminId);
      return reply.send({ rooms });
    });

    app.post(
      '/api/v1/admin/groups',
      async (
        req: FastifyRequest<{
          Body: { name: string; description?: string; type: CommunityRoomType; passcode?: string };
        }>,
        reply
      ) => {
        if (!(await this.validateAdminAuth(req))) {
          return reply.status(401).send({ error: 'Yêu cầu JWT quản trị hợp lệ.' });
        }
        if (!this.groupsService) {
          return reply.status(503).send({ error: 'Dịch vụ Nhóm & Kênh chưa được kích hoạt.' });
        }
        try {
          const room = await this.groupsService.createRoom(config.superAdminId, req.body);
          return reply.status(201).send(room);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Tạo nhóm thất bại.';
          return reply.status(400).send({ error: msg });
        }
      }
    );

    app.post(
      '/api/v1/admin/groups/:roomId/messages',
      async (
        req: FastifyRequest<{ Params: { roomId: string }; Body: { content: string } }>,
        reply
      ) => {
        if (!(await this.validateAdminAuth(req))) {
          return reply.status(401).send({ error: 'Yêu cầu JWT quản trị hợp lệ.' });
        }
        if (!this.groupsService) {
          return reply.status(503).send({ error: 'Dịch vụ Nhóm & Kênh chưa được kích hoạt.' });
        }
        try {
          const msg = await this.groupsService.postMessage(config.superAdminId, req.params.roomId, {
            content: req.body?.content || '',
            type: 'TEXT',
          });
          return reply.status(201).send(msg);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Đăng tin thất bại.';
          return reply.status(400).send({ error: msg });
        }
      }
    );

    app.post(
      '/api/v1/admin/groups/messages/:messageId/delete',
      async (req: FastifyRequest<{ Params: { messageId: string } }>, reply) => {
        if (!(await this.validateAdminAuth(req))) {
          return reply.status(401).send({ error: 'Yêu cầu xác thực quản trị viên hợp lệ.' });
        }
        try {
          const res = await this.adminService.deleteGroupMessage(req.params.messageId, config.superAdminId, req.ip);
          return reply.status(200).send(res);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Gỡ tin nhắn thất bại.';
          const status = msg.includes('không tồn tại') ? 404 : 400;
          return reply.status(status).send({ error: msg });
        }
      }
    );

    // 11. Giao diện Web Quản trị Super Admin (/admin-auth)
    app.get('/admin-auth', async (_req, reply) => {
      const nonce = crypto.randomBytes(16).toString('base64');
      reply.header(
        'Content-Security-Policy',
        `default-src 'self'; script-src 'self' 'nonce-${nonce}' https://accounts.google.com/gsi/client; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com/gsi/style; font-src 'self' https://fonts.gstatic.com; img-src 'self' blob: data: https://lh3.googleusercontent.com https://*.googleusercontent.com; media-src 'self' blob:; connect-src 'self' https://accounts.google.com/gsi/; frame-src 'self' https://accounts.google.com/gsi/; object-src 'none'; frame-ancestors 'none'`
      );
      reply.header('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
      reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
      reply.type('text/html');
      return reply.send(renderAdminDashboardHtml(nonce));
    });

    app.get('/admin', async (_req, reply) => {
      return reply.status(404).send({ error: 'Không tìm thấy trang yêu cầu.' });
    });
  }

}

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type Redis from 'ioredis';
import { AuthService } from './auth.service.js';
import { RegisterDto, LoginDto, GoogleAuthDto, UpdateProfileDto, UpdateStealthVaultDto } from '@chatible/shared';
import { DistributedRateLimiter } from './rate-limiter.js';
import {
  clearAuthCookies,
  clearVaultUnlockCookie,
  getAuthenticatedClaims,
  issueVaultUnlockToken,
  setAuthCookies,
  setVaultUnlockCookie,
  tokenRevocationStore,
  verifyVaultUnlocked,
} from './session-auth.util.js';

export class AuthController {
  private readonly authLimiter = new DistributedRateLimiter(15, 60_000, 'rl:auth:main');
  private readonly resetLimiter = new DistributedRateLimiter(5, 60_000, 'rl:auth:reset');
  private readonly vaultLimiter = new DistributedRateLimiter(5, 60_000, 'rl:auth:vault');

  constructor(private readonly authService: AuthService) {}

  setRedis(redis: Redis): void {
    this.authLimiter.setRedis(redis);
    this.resetLimiter.setRedis(redis);
    this.vaultLimiter.setRedis(redis);
  }

  private async getAuthUserId(req: FastifyRequest): Promise<string> {
    const claims = await getAuthenticatedClaims(req);
    return claims.sub;
  }

  registerRoutes(app: FastifyInstance) {
    // GET /api/v1/auth/config (Public auth feature configuration)
    app.get('/api/v1/auth/config', async (_req: FastifyRequest, reply: FastifyReply) => {
      try {
        const authConfig = await this.authService.getPublicAuthConfig();
        return reply.status(200).send(authConfig);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Không thể lấy cấu hình xác thực';
        return reply.status(500).send({ error: message });
      }
    });

    // POST /api/v1/auth/register (18+ strict validation + HttpOnly Cookie)
    app.post('/api/v1/auth/register', async (req: FastifyRequest<{ Body: RegisterDto }>, reply: FastifyReply) => {
      const clientIp = req.ip || '127.0.0.1';
      if (!(await this.authLimiter.check(`register:${clientIp}`))) {
        return reply.status(429).send({ error: 'Quá nhiều yêu cầu đăng ký. Vui lòng thử lại sau một phút.' });
      }
      try {
        const result = await this.authService.register(req.body);
        if (result.accessToken) {
          setAuthCookies(reply, result.accessToken, result.expiresIn);
        }
        return reply.status(201).send({ expiresIn: result.expiresIn, profile: result.profile });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Đăng ký thất bại';
        return reply.status(400).send({ error: message });
      }
    });

    // POST /api/v1/auth/login (Sets HttpOnly Cookie + CSRF Token, never exposes JWT in JSON)
    app.post('/api/v1/auth/login', async (req: FastifyRequest<{ Body: LoginDto }>, reply: FastifyReply) => {
      const clientIp = req.ip || '127.0.0.1';
      if (!(await this.authLimiter.check(`login:${clientIp}`))) {
        return reply.status(429).send({ error: 'Quá nhiều yêu cầu đăng nhập. Vui lòng thử lại sau một phút.' });
      }
      try {
        const result = await this.authService.login(req.body);
        if (result.accessToken) {
          setAuthCookies(reply, result.accessToken, result.expiresIn);
        }
        return reply.status(200).send({ expiresIn: result.expiresIn, profile: result.profile });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Đăng nhập thất bại';
        return reply.status(401).send({ error: message });
      }
    });

    // POST /api/v1/auth/google (Cookie-only on web)
    app.post('/api/v1/auth/google', async (req: FastifyRequest<{ Body: GoogleAuthDto }>, reply: FastifyReply) => {
      const clientIp = req.ip || '127.0.0.1';
      if (!(await this.authLimiter.check(`google:${clientIp}`))) {
        return reply.status(429).send({ error: 'Quá nhiều yêu cầu xác thực Google. Vui lòng thử lại sau một phút.' });
      }
      try {
        const result = await this.authService.googleAuth(req.body);
        if (result.accessToken) {
          setAuthCookies(reply, result.accessToken, result.expiresIn);
        }
        return reply.status(200).send({ expiresIn: result.expiresIn, profile: result.profile });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Google login thất bại';
        return reply.status(400).send({ error: message });
      }
    });

    // POST /api/v1/auth/logout (Revokes active token JTI and clears HttpOnly cookies)
    app.post('/api/v1/auth/logout', async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const claims = await getAuthenticatedClaims(req);
        if (claims.jti) {
          const ttl = claims.exp ? Math.max(60, claims.exp - Math.floor(Date.now() / 1000)) : 86400;
          await tokenRevocationStore.revokeJti(claims.jti, ttl);
        }
      } catch {
        // Always clear cookies on logout even if session already expired
      }
      clearAuthCookies(reply);
      return reply.status(200).send({ success: true });
    });

    // POST /api/v1/auth/forgot-password
    app.post(
      '/api/v1/auth/forgot-password',
      async (req: FastifyRequest<{ Body: { email: string } }>, reply: FastifyReply) => {
        const clientIp = req.ip || '127.0.0.1';
        if (!(await this.resetLimiter.check(`forgot:${clientIp}`))) {
          return reply.status(429).send({ error: 'Vui lòng chờ 1 phút trước khi yêu cầu mã mới.' });
        }
        try {
          const result = await this.authService.forgotPassword(req.body?.email);
          return reply.status(200).send(result);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Yêu cầu đặt lại mật khẩu thất bại';
          return reply.status(400).send({ error: message });
        }
      }
    );

    // POST /api/v1/auth/reset-password
    app.post(
      '/api/v1/auth/reset-password',
      async (
        req: FastifyRequest<{ Body: { email: string; code: string; newPassword: string } }>,
        reply: FastifyReply
      ) => {
        const clientIp = req.ip || '127.0.0.1';
        if (!(await this.resetLimiter.check(`reset:${clientIp}`))) {
          return reply.status(429).send({ error: 'Quá nhiều lần thử mã đặt lại. Vui lòng thử lại sau 1 phút.' });
        }
        try {
          const result = await this.authService.resetPassword(req.body);
          clearAuthCookies(reply);
          return reply.status(200).send(result);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Đặt lại mật khẩu thất bại';
          return reply.status(400).send({ error: message });
        }
      }
    );

    // POST /api/v1/auth/change-password (AUTH-09: Authenticated password change, revokes old tokens)
    app.post(
      '/api/v1/auth/change-password',
      async (
        req: FastifyRequest<{ Body: { currentPassword?: string; newPassword?: string } }>,
        reply: FastifyReply
      ) => {
        try {
          const userId = await this.getAuthUserId(req);
          const result = await this.authService.changePassword(userId, req.body);
          clearAuthCookies(reply);
          return reply.status(200).send(result);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Đổi mật khẩu thất bại';
          return reply.status(400).send({ error: message });
        }
      }
    );

    // GET /api/v1/users/me (Fetch authenticated user's private profile and preferences)
    app.get('/api/v1/users/me', async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = await this.getAuthUserId(req);
        const myProfile = await this.authService.getMyProfile(userId);
        return reply.status(200).send(myProfile);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Lỗi lấy thông tin tài khoản';
        return reply.status(401).send({ error: message });
      }
    });

    // DELETE /api/v1/users/me (Self-service account deletion)
    app.delete('/api/v1/users/me', async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = await this.getAuthUserId(req);
        const result = await this.authService.deleteAccount(userId);
        clearAuthCookies(reply);
        return reply.status(200).send(result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Xóa tài khoản thất bại';
        return reply.status(400).send({ error: message });
      }
    });

    // GET /api/v1/users/:userId/public (Strictly isolates email, birthDate, IP)
    app.get(
      '/api/v1/users/:userId/public',
      async (req: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
        try {
          const publicProfile = await this.authService.getPublicProfile(req.params.userId);
          return reply.status(200).send(publicProfile);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Không tìm thấy người dùng';
          return reply.status(404).send({ error: message });
        }
      }
    );

    // PUT /api/v1/users/profile (Update nickname & matching preferences)
    app.put('/api/v1/users/profile', async (req: FastifyRequest<{ Body: UpdateProfileDto }>, reply: FastifyReply) => {
      try {
        const userId = await this.getAuthUserId(req);
        const result = await this.authService.updateProfile(userId, req.body);
        return reply.status(200).send(result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Cập nhật hồ sơ thất bại';
        return reply.status(400).send({ error: message });
      }
    });

    // GET /api/v1/users/me/stealth-vault (returns Stealth config + real cookie-verified unlocked status)
    app.get('/api/v1/users/me/stealth-vault', async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = await this.getAuthUserId(req);
        const vaultConfig = await this.authService.getStealthVaultConfig(userId);
        const unlocked = !vaultConfig.enabled || (await verifyVaultUnlocked(req, userId));
        return reply.status(200).send({ ...vaultConfig, unlocked });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Không thể lấy cấu hình Kho riêng tư';
        return reply.status(401).send({ error: message });
      }
    });

    // PUT /api/v1/users/me/stealth-vault (enable, disable, or replace privacy-lock PIN)
    app.put(
      '/api/v1/users/me/stealth-vault',
      async (req: FastifyRequest<{ Body: UpdateStealthVaultDto }>, reply: FastifyReply) => {
        try {
          const userId = await this.getAuthUserId(req);
          const updated = await this.authService.updateStealthVault(userId, req.body);
          clearVaultUnlockCookie(reply);
          return reply.status(200).send(updated);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Không thể cập nhật Kho riêng tư';
          return reply.status(400).send({ error: message });
        }
      }
    );

    // POST /api/v1/users/me/stealth-vault/unlock (Verifies PIN server-side & sets HttpOnly Strict cookie ONLY)
    app.post(
      '/api/v1/users/me/stealth-vault/unlock',
      async (req: FastifyRequest<{ Body: { pin?: string } }>, reply: FastifyReply) => {
        try {
          const userId = await this.getAuthUserId(req);
          const clientIp = req.ip || '127.0.0.1';
          if (!(await this.vaultLimiter.check(`vault:${userId}:${clientIp}`))) {
            return reply.status(429).send({ error: 'Đã thử quá nhiều lần. Vui lòng chờ một phút.' });
          }
          const result = await this.authService.unlockStealthVault(userId, req.body?.pin);
          const vaultToken = issueVaultUnlockToken(userId, 600);
          setVaultUnlockCookie(reply, vaultToken, 600);
          return reply.status(200).send({ ...result, unlocked: true, expiresIn: 600 });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Không thể mở khóa Kho riêng tư';
          return reply.status(400).send({ error: message });
        }
      }
    );

    // POST /api/v1/users/me/stealth-vault/lock (Revokes vault unlock cookie immediately)
    app.post('/api/v1/users/me/stealth-vault/lock', async (_req: FastifyRequest, reply: FastifyReply) => {
      clearVaultUnlockCookie(reply);
      return reply.status(200).send({ unlocked: false });
    });
  }
}

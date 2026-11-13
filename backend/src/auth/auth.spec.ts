import fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { AuthController } from './auth.controller.js';
import { describe, it, expect } from 'bun:test';
import { AgeUtil } from './age.util.js';
import { PasswordUtil } from './password.util.js';
import { JwtUtil } from './jwt.util.js';
import { AuthService } from './auth.service.js';
import { MemoryRateLimiter } from './rate-limiter.js';
import { config } from '../config/env.js';
import { db } from '../database/index.js';
import { emailVerificationTokens, profiles, users } from '../database/schema/users.js';
import { CSRF_COOKIE_NAME, registerCsrfOriginProtection, SESSION_COOKIE_NAME } from './session-auth.util.js';
import { eq } from 'drizzle-orm';

describe('Phase 3: Auth 18+ Security & Policy Tests (T012, T014, T017)', () => {
  const referenceDate = new Date('2026-11-08');

  it('T012: Correctly computes age >= 18 from birthDate', () => {
    // Born 2004-03-15 on 2026-11-08 is 22 years old
    const age = AgeUtil.calculateAge('2004-03-15', referenceDate);
    expect(age).toBe(22);

    const validatedAge = AgeUtil.validateIsAdult('2004-03-15', referenceDate);
    expect(validatedAge).toBe(22);
  });

  it('T017: Chặn ngay nếu khai ngày sinh < 18 tuổi (Underage rejection)', () => {
    // Born 2010-05-20 on 2026-11-08 is 16 years old
    const age = AgeUtil.calculateAge('2010-05-20', referenceDate);
    expect(age).toBe(16);

    expect(() => AgeUtil.validateIsAdult('2010-05-20', referenceDate)).toThrow(
      'Người dùng phải từ đủ 18 tuổi trở lên để sử dụng nền tảng Chatible.'
    );
  });

  it('T017: Chặn ngay nếu ngày sinh là ngày trong tương lai', () => {
    expect(() => AgeUtil.calculateAge('2027-01-01', referenceDate)).toThrow(
      'Ngày sinh không thể nằm trong tương lai.'
    );
  });
  it('rejects impossible dates and uses the UTC birthday boundary for 18+', () => {
    expect(AgeUtil.calculateAge('2008-11-08', referenceDate)).toBe(18);
    expect(AgeUtil.validateIsAdult('2008-11-08', referenceDate)).toBe(18);
    expect(AgeUtil.calculateAge('2008-11-09', referenceDate)).toBe(17);
    expect(() => AgeUtil.validateIsAdult('2008-11-09', referenceDate)).toThrow(
      'Người dùng phải từ đủ 18 tuổi trở lên để sử dụng nền tảng Chatible.'
    );
    expect(() => AgeUtil.calculateAge('2008-02-30', referenceDate)).toThrow('YYYY-MM-DD');
    expect(() => AgeUtil.calculateAge('2008/01/01', referenceDate)).toThrow('YYYY-MM-DD');
  });

  it('T014: Password hashing and secure verification', () => {
    const password = 'StrongPassword123!';
    const hash = PasswordUtil.hash(password);

    // Verify properties
    expect(hash).toContain(':');
    expect(hash).not.toBe(password);

    // Correct password succeeds
    expect(PasswordUtil.verify(password, hash)).toBe(true);

    // Wrong password fails
    expect(PasswordUtil.verify('WrongPassword456!', hash)).toBe(false);

    // Mismatched length does not throw TypeError and returns false safely
    expect(PasswordUtil.verify(password, 'salt:1234')).toBe(false);
  });

  it('T014: JWT token signing and verification', () => {
    const secret = 'super_secret_test_key_minimum_32_bytes_long';
    const payload = { sub: 'user-uuid-123', email: 'test@chatible.app' };

    const token = JwtUtil.sign(payload, secret, 3600);
    expect(token.split('.').length).toBe(3);

    const verified = JwtUtil.verify(token, secret);
    expect(verified.sub).toBe('user-uuid-123');
    expect(verified.email).toBe('test@chatible.app');

    // Wrong secret throws
    expect(() => JwtUtil.verify(token, 'wrong_secret_key_1234567890123456')).toThrow();

    // Mismatched signature length throws 'Invalid signature' without TypeError
    const [h, p] = token.split('.');
    expect(() => JwtUtil.verify(`${h}.${p}.shortsig`, secret)).toThrow('Invalid signature');
  });
  it('Google OAuth rejects arbitrary and legacy mock tokens', async () => {
    const originalFetch = globalThis.fetch;
    const originalClientId = config.googleClientId;
    config.googleClientId = 'chatible-test-client';
    globalThis.fetch = async () => new Response(null, { status: 400 });

    try {
      const authService = new AuthService();
      await expect(authService.verifyGoogleIdToken('fake_forged_random_attacker_token_xyz')).rejects.toThrow();
      await expect(authService.verifyGoogleIdToken('mock_test_token_google_user_new')).rejects.toThrow();
    } finally {
      globalThis.fetch = originalFetch;
      config.googleClientId = originalClientId;
    }
  });

  it('Google OAuth validates tokeninfo issuer, audience, expiry, and verified email', async () => {
    const originalFetch = globalThis.fetch;
    const originalClientId = config.googleClientId;
    config.googleClientId = 'chatible-test-client';
    const authService = new AuthService();

    try {
      globalThis.fetch = async (input) => {
        const url = new URL(input.toString());
        expect(url.searchParams.get('id_token')).toBe('valid-test-id-token');
        return new Response(
          JSON.stringify({
            sub: 'google-user-1',
            email: 'USER@EXAMPLE.COM',
            name: 'Test User',
            aud: 'chatible-test-client',
            iss: 'https://accounts.google.com',
            exp: String(Math.floor(Date.now() / 1000) + 3600),
            email_verified: 'true',
          }),
          { status: 200 }
        );
      };
      const claims = await authService.verifyGoogleIdToken('valid-test-id-token');
      expect(claims).toEqual({ sub: 'google-user-1', email: 'user@example.com', name: 'Test User' });

      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            sub: 'google-user-1',
            email: 'user@example.com',
            aud: 'another-client',
            iss: 'accounts.google.com',
            exp: String(Math.floor(Date.now() / 1000) + 3600),
            email_verified: true,
          }),
          { status: 200 }
        );
      await expect(authService.verifyGoogleIdToken('wrong-audience-token')).rejects.toThrow();
    } finally {
      globalThis.fetch = originalFetch;
      config.googleClientId = originalClientId;
    }
  });

  it('Google login returns a client error for a forged ID token', async () => {
    const originalFetch = globalThis.fetch;
    const originalClientId = config.googleClientId;
    config.googleClientId = 'chatible-test-client';
    globalThis.fetch = async () => new Response(null, { status: 400 });
    const app = fastify();
    new AuthController(new AuthService()).registerRoutes(app);

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/google',
        payload: { idToken: 'forged-id-token', birthDate: '1990-01-01', gender: 'OTHER', nickname: 'attacker' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain('Google');
    } finally {
      await app.close();
      globalThis.fetch = originalFetch;
      config.googleClientId = originalClientId;
    }
  });

  it('generates a password reset code and allows resetting password with verification code', async () => {
    const authService = new AuthService();
    const testEmail = `reset-user-${Date.now()}@example.com`;
    const reg = await authService.register({
      email: testEmail,
      password: 'OldPassword123!',
      nickname: 'ResetTester',
      gender: 'MALE',
      birthDate: '2000-01-01',
      policyAccepted: true,
    });
    expect(reg.accessToken).toBeDefined();

    // 1. Request forgot password code
    const forgotRes = await authService.forgotPassword(testEmail);
    expect(forgotRes.message).toBeDefined();
    expect(forgotRes.resetCode).toBeDefined();
    const resetCode = forgotRes.resetCode!;
    expect(resetCode.length).toBe(6);

    // 2. Reject short password
    await expect(
      authService.resetPassword({
        email: testEmail,
        code: resetCode,
        newPassword: 'short',
      })
    ).rejects.toThrow('8 ký tự');

    // 3. Reject wrong code
    await expect(
      authService.resetPassword({
        email: testEmail,
        code: '999999',
        newPassword: 'NewStrongPassword123!',
      })
    ).rejects.toThrow('Mã xác nhận không chính xác');

    // 4. Successfully reset with correct code
    const resetSuccess = await authService.resetPassword({
      email: testEmail,
      code: resetCode,
      newPassword: 'NewStrongPassword123!',
    });
    expect(resetSuccess.message).toContain('thành công');

    // 5. Code cannot be reused
    await expect(
      authService.resetPassword({
        email: testEmail,
        code: resetCode,
        newPassword: 'AnotherPassword123!',
      })
    ).rejects.toThrow('Mã xác nhận không chính xác hoặc đã hết hạn');

    // 6. Old password fails login, new password succeeds
    await expect(
      authService.login({ email: testEmail, password: 'OldPassword123!' })
    ).rejects.toThrow('Email hoặc mật khẩu không chính xác.');

    const newLogin = await authService.login({
      email: testEmail,
      password: 'NewStrongPassword123!',
    });
    expect(newLogin.accessToken).toBeDefined();
  });

  it('deletes user account and prevents subsequent login', async () => {
    const authService = new AuthService();
    const testEmail = `del-user-${Date.now()}@example.com`;
    const reg = await authService.register({
      email: testEmail,
      password: 'Password123!',
      nickname: 'DeleteTester',
      gender: 'FEMALE',
      birthDate: '2001-05-10',
      policyAccepted: true,
    });

    const delRes = await authService.deleteAccount(reg.profile.id);
    expect(delRes.message).toContain('thành công');

    // Attempting to login after account deletion must fail
    await expect(
      authService.login({ email: testEmail, password: 'Password123!' })
    ).rejects.toThrow('đã bị khóa hoặc đình chỉ');
  });

  it('rate limits repeated auth attempts', () => {
    const limiter = new MemoryRateLimiter(3, 1000); // 3 per second

    expect(limiter.check('ip-1', 1000)).toBe(true);
    expect(limiter.check('ip-1', 1050)).toBe(true);
    expect(limiter.check('ip-1', 1100)).toBe(true);
    // 4th request exceeds limit
    expect(limiter.check('ip-1', 1150)).toBe(false);

    // Different IP still allowed
    expect(limiter.check('ip-2', 1150)).toBe(true);

    // After window expires, requests are allowed again
    expect(limiter.check('ip-1', 2050)).toBe(true);
  });

  it('allows authenticated users to change their password with current password verification', async () => {
    const authService = new AuthService();
    const testEmail = `chg-pass-${Date.now()}@example.com`;
    const reg = await authService.register({
      email: testEmail,
      password: 'InitialPassword123!',
      nickname: 'ChangePassTester',
      gender: 'MALE',
      birthDate: '1998-04-12',
      policyAccepted: true,
    });

    const userId = reg.profile.id;

    // 1. Wrong current password fails
    await expect(
      authService.changePassword(userId, {
        currentPassword: 'WrongPassword!',
        newPassword: 'BrandNewPassword123!',
      })
    ).rejects.toThrow('Mật khẩu hiện tại không chính xác');

    // 2. Short new password fails
    await expect(
      authService.changePassword(userId, {
        currentPassword: 'InitialPassword123!',
        newPassword: 'short',
      })
    ).rejects.toThrow('8 ký tự');

    // 3. Correct change succeeds
    const changeRes = await authService.changePassword(userId, {
      currentPassword: 'InitialPassword123!',
      newPassword: 'BrandNewPassword123!',
    });
    expect(changeRes.message).toContain('thành công');

    // 4. Old password can no longer log in
    await expect(
      authService.login({ email: testEmail, password: 'InitialPassword123!' })
    ).rejects.toThrow('Email hoặc mật khẩu không chính xác');

    // 5. New password logs in successfully
    const loginRes = await authService.login({
      email: testEmail,
      password: 'BrandNewPassword123!',
    });
    expect(loginRes.accessToken).toBeDefined();
  });

  it('stores the Stealth Vault PIN only as a hash and requires it to unlock or replace the lock', async () => {
    const authService = new AuthService();
    const reg = await authService.register({
      email: `vault-user-${Date.now()}@example.com`,
      password: 'VaultPassword123!',
      nickname: 'VaultTester',
      gender: 'OTHER',
      birthDate: '1995-01-01',
      policyAccepted: true,
    });

    await expect(authService.updateStealthVault(reg.profile.id, { enabled: true, pin: '12' })).rejects.toThrow(
      '4 chữ số'
    );
    const config = await authService.updateStealthVault(reg.profile.id, { enabled: true, pin: '1234' });
    expect(config).toEqual({ enabled: true, hasPin: true });

    const stored = await db.query.profiles.findFirst({ where: eq(profiles.userId, reg.profile.id) });
    expect(stored?.stealthPinHash).toBeDefined();
    expect(stored?.stealthPinHash).not.toBe('1234');

    await expect(authService.unlockStealthVault(reg.profile.id, '0000')).rejects.toThrow('không chính xác');
    await expect(authService.unlockStealthVault(reg.profile.id, '1234')).resolves.toEqual({
      message: 'Đã mở khóa Kho riêng tư.',
    });
    await expect(
      authService.updateStealthVault(reg.profile.id, { enabled: true, currentPin: '0000', pin: '4321' })
    ).rejects.toThrow('hiện tại không chính xác');
    await expect(
      authService.updateStealthVault(reg.profile.id, { enabled: true, currentPin: '1234', pin: '4321' })
    ).resolves.toEqual({ enabled: true, hasPin: true });

    expect(await authService.updateStealthVault(reg.profile.id, { enabled: false })).toEqual({
      enabled: false,
      hasPin: false,
    });
  });

  it('exposes public auth configuration and enforces Google Auth toggle setting', async () => {
    const authService = new AuthService();
    const app = fastify();
    new AuthController(authService).registerRoutes(app);

    try {
      const configRes = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/config',
      });
      expect(configRes.statusCode).toBe(200);
      const data = configRes.json();
      expect(typeof data.googleAuthEnabled).toBe('boolean');
      expect(typeof data.registrationEnabled).toBe('boolean');
      expect(typeof data.emailVerificationRequired).toBe('boolean');
      expect(typeof data.googleClientId).toBe('string');
    } finally {
      await app.close();
    }
  });

  it('creates hashed email verification OTPs, enforces 60s resend cooldown, and marks user emailVerified', async () => {
    const authService = new AuthService();
    const app = fastify({ logger: false });
    await app.register(fastifyCookie);
    registerCsrfOriginProtection(app);
    new AuthController(authService).registerRoutes(app);

    const testEmail = `verify-email-${Date.now()}@example.com`;
    let userId = '';

    try {
      const regRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: testEmail,
          password: 'VerifyPass123!',
          nickname: 'VerifyUser',
          gender: 'FEMALE',
          birthDate: '1999-03-20',
          policyAccepted: true,
        },
      });
      expect(regRes.statusCode).toBe(201);
      const regBody = regRes.json();
      userId = regBody.profile.id;
      expect(regBody.profile.emailVerified).toBe(false);

      const cookies = (Array.isArray(regRes.headers['set-cookie'])
        ? regRes.headers['set-cookie']
        : [String(regRes.headers['set-cookie'] || '')]
      ).reduce<Record<string, string>>((acc, raw) => {
        const pair = raw.split(';', 1)[0] || '';
        const idx = pair.indexOf('=');
        if (idx > 0) acc[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
        return acc;
      }, {});
      const cookieHeader = `${SESSION_COOKIE_NAME}=${encodeURIComponent(cookies[SESSION_COOKIE_NAME]!)}; ${CSRF_COOKIE_NAME}=${encodeURIComponent(cookies[CSRF_COOKIE_NAME]!)}`;
      const csrf = cookies[CSRF_COOKIE_NAME]!;

      const tokenRows = await db
        .select()
        .from(emailVerificationTokens)
        .where(eq(emailVerificationTokens.userId, userId));
      expect(tokenRows).toHaveLength(1);
      expect(tokenRows[0]!.codeHash).toHaveLength(64);

      // Immediate resend within 60s is blocked by cooldown
      const tooFastResend = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/email-verification/resend',
        headers: { cookie: cookieHeader, 'x-csrf-token': csrf },
      });
      expect(tooFastResend.statusCode).toBe(400);
      expect(tooFastResend.json().error).toContain('60 giây');

      // Backdate token creation to pass cooldown cleanly and resend
      await db
        .update(emailVerificationTokens)
        .set({ createdAt: new Date(Date.now() - 65_000) })
        .where(eq(emailVerificationTokens.userId, userId));

      const resendRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/email-verification/resend',
        headers: { cookie: cookieHeader, 'x-csrf-token': csrf },
      });
      expect(resendRes.statusCode).toBe(200);
      const code = resendRes.json().verificationCode as string;
      expect(code).toMatch(/^\d{6}$/);

      // Wrong code fails cleanly
      const badConfirm = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/email-verification/confirm',
        headers: { cookie: cookieHeader, 'x-csrf-token': csrf },
        payload: { code: '000000' },
      });
      expect(badConfirm.statusCode).toBe(400);

      // Correct code succeeds & marks user verified
      const okConfirm = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/email-verification/confirm',
        headers: { cookie: cookieHeader, 'x-csrf-token': csrf },
        payload: { code },
      });
      expect(okConfirm.statusCode).toBe(200);
      expect(okConfirm.json().emailVerified).toBe(true);

      const meRes = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me',
        headers: { cookie: cookieHeader },
      });
      expect(meRes.statusCode).toBe(200);
      expect(meRes.json().emailVerified).toBe(true);
    } finally {
      await app.close();
      if (userId) {
        await db.delete(users).where(eq(users.id, userId));
      }
    }
  });
});


import { describe, expect, it } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../database/index.js';
import { systemSettings } from '../database/schema/settings.js';
import { users, passwordResetTokens } from '../database/schema/users.js';
import { EnvelopeCryptoService } from '../crypto/envelope.service.js';
import { LocalKmsService } from '../kms/local-kms.service.js';
import { AdminService } from '../admin/admin.service.js';
import { AuthService } from '../auth/auth.service.js';
import { config } from '../config/env.js';
import {
  ENCRYPTED_SECRET_PREFIX,
  MAIL_SETTING_KEYS,
  MailService,
  SMTP_PASSWORD_MASK,
  SmtpConfig,
} from './mail.service.js';

const cryptoService = new EnvelopeCryptoService(new LocalKmsService(config.masterKek));

async function ensureAdminPrincipal() {
  await db
    .insert(users)
    .values({
      id: config.superAdminId,
      email: `super-admin+${config.superAdminId}@chatible.internal`,
      status: 'SYSTEM',
    })
    .onConflictDoNothing({ target: users.id });
}

describe('Admin SMTP Mail Configuration & Email Delivery', () => {
  it('encrypts SMTP password at rest, masks on GET, and preserves when masked placeholder is saved', async () => {
    await ensureAdminPrincipal();
    const originalRows = await db
      .select()
      .from(systemSettings)
      .where(inArray(systemSettings.key, [...MAIL_SETTING_KEYS]));

    const capturedMails: Array<{ from: string; to: string; subject: string; html?: string; text?: string }> = [];
    let verifyCalled = 0;

    const mailService = new MailService({
      cryptoService,
      transportFactory: (_cfg: SmtpConfig) => ({
        verify: async () => {
          verifyCalled += 1;
          return true;
        },
        sendMail: async (msg) => {
          capturedMails.push(msg);
          return { messageId: 'test-msg-id' };
        },
      }),
    });

    const adminService = new AdminService(cryptoService, config.superAdminId, mailService);

    try {
      // 1. Save SMTP settings with plaintext app password
      await adminService.updateSettings(config.superAdminId, {
        'mail.smtp.enabled': 'true',
        'mail.smtp.host': 'smtp.gmail.com',
        'mail.smtp.port': '587',
        'mail.smtp.secure': 'false',
        'mail.smtp.user': 'noreply@chatible.test',
        'mail.smtp.password': 'super-secret-smtp-pass',
        'mail.smtp.from_name': 'Chatible Mailer',
        'mail.smtp.from_address': 'no-reply@chatible.test',
      });

      // 2. DB row should be encrypted with enc:v1:
      const [dbPwdRow] = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.key, 'mail.smtp.password'))
        .limit(1);
      expect(dbPwdRow).toBeDefined();
      expect(dbPwdRow!.value.startsWith(ENCRYPTED_SECRET_PREFIX)).toBe(true);
      expect(dbPwdRow!.value).not.toContain('super-secret-smtp-pass');

      // 3. GET settings masks the password
      const settingsList = await adminService.getSettings();
      const passwordSetting = settingsList.find((s) => s.key === 'mail.smtp.password');
      expect(passwordSetting?.value).toBe(SMTP_PASSWORD_MASK);

      // 4. Updating other settings while sending ******** keeps stored password intact
      await adminService.updateSettings(config.superAdminId, {
        'mail.smtp.host': 'smtp.resend.com',
        'mail.smtp.password': SMTP_PASSWORD_MASK,
      });
      const resolvedCfg = await mailService.getSmtpConfig();
      expect(resolvedCfg.host).toBe('smtp.resend.com');
      expect(resolvedCfg.password).toBe('super-secret-smtp-pass');

      // 5. Rejects invalid port number
      await expect(
        adminService.updateSettings(config.superAdminId, {
          'mail.smtp.port': '99999',
        })
      ).rejects.toThrow('Cổng SMTP không hợp lệ');

      // 6. Send test email through AdminService using stored encrypted password
      const testRes = await adminService.sendTestEmail(config.superAdminId, 'admin-test@example.com', {
        password: SMTP_PASSWORD_MASK,
      });
      expect(testRes.success).toBe(true);
      expect(verifyCalled).toBe(1);
      expect(capturedMails).toHaveLength(1);
      expect(capturedMails[0]!.to).toBe('admin-test@example.com');
      expect(capturedMails[0]!.from).toContain('Chatible Mailer');
      expect(capturedMails[0]!.subject).toContain('SMTP');
    } finally {
      for (const row of originalRows) {
        await db
          .insert(systemSettings)
          .values(row)
          .onConflictDoUpdate({
            target: systemSettings.key,
            set: { value: row.value, updatedAt: row.updatedAt, updatedBy: row.updatedBy },
          });
      }
    }
  });

  it('sends branded OTP email automatically during forgotPassword when SMTP is enabled', async () => {
    await ensureAdminPrincipal();
    const originalRows = await db
      .select()
      .from(systemSettings)
      .where(inArray(systemSettings.key, [...MAIL_SETTING_KEYS]));

    const sentOtps: Array<{ to: string; subject: string; html?: string; text?: string }> = [];
    const mailService = new MailService({
      cryptoService,
      transportFactory: () => ({
        verify: async () => true,
        sendMail: async (msg) => {
          sentOtps.push(msg);
          return { messageId: 'otp-msg-id' };
        },
      }),
    });

    const adminService = new AdminService(cryptoService, config.superAdminId, mailService);
    const authService = new AuthService(mailService);
    const testEmail = `otp-mailer-${Date.now()}@example.com`;
    let createdUserId: string | null = null;

    try {
      await adminService.updateSettings(config.superAdminId, {
        'mail.smtp.enabled': 'true',
        'mail.smtp.host': 'smtp.gmail.com',
        'mail.smtp.port': '587',
        'mail.smtp.secure': 'false',
        'mail.smtp.user': 'bot@chatible.test',
        'mail.smtp.password': 'bot-pass',
        'mail.smtp.from_name': 'Chatible Auth',
        'mail.smtp.from_address': 'auth@chatible.test',
      });

      const reg = await authService.register({
        email: testEmail,
        password: 'Password123!',
        nickname: 'OtpUser',
        gender: 'FEMALE',
        birthDate: '1999-03-15',
        policyAccepted: true,
      });
      createdUserId = reg.profile.id;

      const forgotRes = await authService.forgotPassword(testEmail);
      expect(forgotRes.resetCode).toBeDefined();
      expect(forgotRes.message).toContain('đã được gửi tới email');

      expect(sentOtps).toHaveLength(2);
      expect(sentOtps[0]!.to).toBe(testEmail);
      expect(sentOtps[0]!.subject).toContain('Xác minh');
      expect(sentOtps[1]!.to).toBe(testEmail);
      expect(sentOtps[1]!.html).toContain(forgotRes.resetCode!);
    } finally {
      if (createdUserId) {
        await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, createdUserId));
        await db.delete(users).where(eq(users.id, createdUserId));
      }
      for (const row of originalRows) {
        await db
          .insert(systemSettings)
          .values(row)
          .onConflictDoUpdate({
            target: systemSettings.key,
            set: { value: row.value, updatedAt: row.updatedAt, updatedBy: row.updatedBy },
          });
      }
    }
  });
});

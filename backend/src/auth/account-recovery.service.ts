import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { db } from '../database/index.js';
import { emailVerificationTokens, passwordResetTokens, users } from '../database/schema/users.js';
import { MailService } from '../mail/mail.service.js';
import { assertActiveAccount } from './account-status.util.js';
import { PasswordUtil } from './password.util.js';
import { tokenRevocationStore } from './session-auth.util.js';

/**
 * Handles email verification OTPs, password reset recovery codes,
 * and authenticated password changes with automatic token revocation.
 */
export class AccountRecoveryService {
  constructor(private readonly mailService: MailService) {}

  private hashVerificationCode(userId: string, code: string): string {
    return createHash('sha256').update(`${userId}:${code.trim()}`).digest('hex');
  }

  async issueAndSendEmailVerificationCode(
    userId: string,
    email: string
  ): Promise<{ sent: boolean; message: string; verificationCode?: string }> {
    const code = String(randomInt(100000, 999999));
    const codeHash = this.hashVerificationCode(userId, code);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);

    await db.transaction(async (tx) => {
      await tx
        .update(emailVerificationTokens)
        .set({ usedAt: now })
        .where(and(eq(emailVerificationTokens.userId, userId), isNull(emailVerificationTokens.usedAt)));
      await tx.insert(emailVerificationTokens).values({
        userId,
        email,
        codeHash,
        expiresAt,
      });
    });

    const mailResult = await this.mailService.sendEmailVerificationOtp(email, code);
    return {
      sent: mailResult.sent,
      message: mailResult.sent
        ? 'Mã xác minh 6 số đã được gửi tới email của bạn (hết hạn sau 15 phút).'
        : 'Mã xác minh 6 số đã được tạo (hết hạn sau 15 phút).',
      verificationCode: !mailResult.sent && process.env.NODE_ENV !== 'production' ? code : undefined,
    };
  }

  async resendEmailVerification(userId: string): Promise<{
    alreadyVerified: boolean;
    sent: boolean;
    message: string;
    verificationCode?: string;
  }> {
    const user = await assertActiveAccount(userId);
    if (user.emailVerifiedAt) {
      return {
        alreadyVerified: true,
        sent: false,
        message: 'Email tài khoản của bạn đã được xác minh.',
      };
    }

    const latest = await db.query.emailVerificationTokens.findFirst({
      where: eq(emailVerificationTokens.userId, userId),
      orderBy: [desc(emailVerificationTokens.createdAt)],
    });
    if (latest && latest.createdAt.getTime() > Date.now() - 60_000) {
      throw new Error('Vui lòng chờ 60 giây trước khi yêu cầu gửi lại mã xác minh.');
    }

    const result = await this.issueAndSendEmailVerificationCode(user.id, user.email);
    return { alreadyVerified: false, ...result };
  }

  async verifyEmailCode(userId: string, rawCode: string): Promise<{
    verified: boolean;
    emailVerified: boolean;
    message: string;
  }> {
    const user = await assertActiveAccount(userId);
    if (user.emailVerifiedAt) {
      return {
        verified: true,
        emailVerified: true,
        message: 'Email tài khoản của bạn đã được xác minh.',
      };
    }

    const code = rawCode?.trim();
    if (!code || !/^\d{6}$/.test(code)) {
      throw new Error('Mã xác minh email phải gồm đúng 6 chữ số.');
    }

    const codeHash = this.hashVerificationCode(userId, code);
    const now = new Date();
    await db.transaction(async (tx) => {
      const [record] = await tx
        .select({ id: emailVerificationTokens.id })
        .from(emailVerificationTokens)
        .where(
          and(
            eq(emailVerificationTokens.userId, userId),
            eq(emailVerificationTokens.codeHash, codeHash),
            isNull(emailVerificationTokens.usedAt),
            gt(emailVerificationTokens.expiresAt, now)
          )
        )
        .limit(1);

      if (!record) {
        throw new Error('Mã xác minh không chính xác hoặc đã hết hạn.');
      }

      await tx
        .update(emailVerificationTokens)
        .set({ usedAt: now })
        .where(and(eq(emailVerificationTokens.userId, userId), isNull(emailVerificationTokens.usedAt)));
      await tx
        .update(users)
        .set({ emailVerifiedAt: now, updatedAt: now })
        .where(eq(users.id, userId));
    });

    return {
      verified: true,
      emailVerified: true,
      message: 'Xác minh địa chỉ email thành công!',
    };
  }

  async forgotPassword(email: string): Promise<{ message: string; resetCode?: string }> {
    const normalizedEmail = email?.toLowerCase().trim();
    if (!normalizedEmail) {
      throw new Error('Vui lòng cung cấp email hợp lệ.');
    }

    const user = await db.query.users.findFirst({
      where: eq(users.email, normalizedEmail),
    });

    if (!user || user.status === 'DELETED') {
      // Neutral response to prevent email enumeration
      return {
        message: 'Nếu email tồn tại trong hệ thống, mã xác nhận đặt lại mật khẩu đã được tạo và gửi.',
      };
    }

    if (user.status === 'RESTRICTED') {
      throw new Error('Tài khoản này đã bị hạn chế do vi phạm chính sách cộng đồng.');
    }

    const code = String(randomInt(100000, 999999));
    const tokenHash = randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins

    await db.insert(passwordResetTokens).values({
      userId: user.id,
      code,
      tokenHash,
      expiresAt,
    });

    const mailResult = await this.mailService.sendPasswordResetOtp(user.email, code);

    return {
      message: mailResult.sent
        ? 'Mã xác nhận 6 số đã được gửi tới email của bạn (hết hạn trong 15 phút).'
        : 'Mã xác nhận 6 số đã được tạo thành công (hết hạn trong 15 phút).',
      resetCode: process.env.NODE_ENV !== 'production' ? code : undefined,
    };
  }

  async resetPassword(dto: { email: string; code: string; newPassword: string }): Promise<{ message: string }> {
    const normalizedEmail = dto.email?.toLowerCase().trim();
    const code = dto.code?.trim();
    const newPassword = dto.newPassword;

    if (!normalizedEmail || !code || !newPassword) {
      throw new Error('Vui lòng cung cấp đầy đủ email, mã xác nhận và mật khẩu mới.');
    }

    if (newPassword.length < 8) {
      throw new Error('Mật khẩu mới phải có độ dài tối thiểu 8 ký tự.');
    }

    const user = await db.query.users.findFirst({
      where: eq(users.email, normalizedEmail),
    });

    if (!user || user.status === 'DELETED') {
      throw new Error('Tài khoản không tồn tại.');
    }

    if (user.status === 'RESTRICTED') {
      throw new Error('Tài khoản đã bị hạn chế vi phạm.');
    }

    const now = new Date();
    const [tokenRecord] = await db
      .select()
      .from(passwordResetTokens)
      .where(
        and(
          eq(passwordResetTokens.userId, user.id),
          eq(passwordResetTokens.code, code),
          gt(passwordResetTokens.expiresAt, now)
        )
      )
      .orderBy(desc(passwordResetTokens.createdAt))
      .limit(1);

    if (!tokenRecord || tokenRecord.usedAt) {
      throw new Error('Mã xác nhận không chính xác hoặc đã hết hạn. Vui lòng yêu cầu mã mới.');
    }

    const newHash = PasswordUtil.hash(newPassword);

    await db
      .update(users)
      .set({ passwordHash: newHash, updatedAt: now })
      .where(eq(users.id, user.id));

    await db
      .update(passwordResetTokens)
      .set({ usedAt: now })
      .where(eq(passwordResetTokens.id, tokenRecord.id));

    await tokenRevocationStore.revokeUserTokensBefore(user.id, Date.now());

    return {
      message: 'Đặt lại mật khẩu thành công. Bạn có thể đăng nhập bằng mật khẩu mới.',
    };
  }

  async changePassword(
    userId: string,
    dto: { currentPassword?: string; newPassword?: string }
  ): Promise<{ message: string }> {
    const currentPassword = dto?.currentPassword?.trim();
    const newPassword = dto?.newPassword?.trim();

    if (!currentPassword || !newPassword) {
      throw new Error('Vui lòng cung cấp mật khẩu hiện tại và mật khẩu mới.');
    }

    if (newPassword.length < 8) {
      throw new Error('Mật khẩu mới phải có độ dài tối thiểu 8 ký tự.');
    }

    const user = await assertActiveAccount(userId);

    if (!user.passwordHash) {
      throw new Error('Tài khoản đăng nhập qua Google chưa thiết lập mật khẩu.');
    }

    const isMatch = PasswordUtil.verify(currentPassword, user.passwordHash);
    if (!isMatch) {
      throw new Error('Mật khẩu hiện tại không chính xác.');
    }

    const newPasswordHash = PasswordUtil.hash(newPassword);
    const now = new Date();

    await db
      .update(users)
      .set({
        passwordHash: newPasswordHash,
        updatedAt: now,
      })
      .where(eq(users.id, userId));

    await tokenRevocationStore.revokeUserTokensBefore(userId, Date.now());

    return {
      message: 'Đổi mật khẩu thành công.',
    };
  }
}

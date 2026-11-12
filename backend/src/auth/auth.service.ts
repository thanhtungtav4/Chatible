import { and, desc, eq, gt, or } from 'drizzle-orm';
import { randomBytes, randomInt } from 'node:crypto';
import { db } from '../database/index.js';
import { users, profiles, passwordResetTokens } from '../database/schema/users.js';
import { friendRequests, friendships } from '../database/schema/friends.js';
import { systemSettings } from '../database/schema/settings.js';
import { AgeUtil } from './age.util.js';
import { PasswordUtil } from './password.util.js';
import { JwtUtil } from './jwt.util.js';
import { config } from '../config/env.js';
import { MailService } from '../mail/mail.service.js';
import { tokenRevocationStore } from './session-auth.util.js';
import {
  RegisterDto,
  LoginDto,
  GoogleAuthDto,
  AuthResponse,
  UserPrivateProfile,
  UserPublicProfile,
  Gender,
  TargetGender,
  UpdateProfileDto,
  StealthVaultConfig,
  UpdateStealthVaultDto,
} from '@chatible/shared';

export class AuthService {
  constructor(private readonly mailService: MailService = new MailService()) {}

  async getSystemSetting(key: string, defaultValue = ''): Promise<string> {
    try {
      const [row] = await db
        .select({ value: systemSettings.value })
        .from(systemSettings)
        .where(eq(systemSettings.key, key))
        .limit(1);
      return row ? row.value : defaultValue;
    } catch {
      return defaultValue;
    }
  }

  async getPublicAuthConfig(): Promise<{
    googleAuthEnabled: boolean;
    googleClientId: string;
    registrationEnabled: boolean;
  }> {
    const googleEnabledStr = await this.getSystemSetting('auth.google.enabled', 'true');
    const googleClientIdDb = await this.getSystemSetting('auth.google.client_id', '');
    const regEnabledStr = await this.getSystemSetting('auth.registration.enabled', 'true');

    const googleClientId = googleClientIdDb.trim() || config.googleClientId || '';

    return {
      googleAuthEnabled: googleEnabledStr === 'true' && Boolean(googleClientId),
      googleClientId,
      registrationEnabled: regEnabledStr !== 'false',
    };
  }

  /**
   * Register a new user with strictly validated 18+ birth date
   */
  async register(dto: RegisterDto): Promise<AuthResponse> {
    const regEnabled = await this.getSystemSetting('auth.registration.enabled', 'true');
    if (regEnabled === 'false') {
      throw new Error('Hệ thống hiện đang tạm đóng chức năng đăng ký tài khoản mới.');
    }

    if (!dto.email || !dto.password || !dto.birthDate || !dto.nickname || !dto.gender) {
      throw new Error('Vui lòng điền đầy đủ các thông tin bắt buộc.');
    }

    if (!dto.policyAccepted) {
      throw new Error('Bạn phải đồng ý với Điều khoản và Chính sách 18+ của Chatible.');
    }

    if (dto.password.length < 8) {
      throw new Error('Mật khẩu phải có độ dài tối thiểu 8 ký tự.');
    }

    // Constitutional Invariant I: 18+ check
    const calculatedAge = AgeUtil.validateIsAdult(dto.birthDate);

    // Check duplicate email
    const existing = await db.query.users.findFirst({
      where: eq(users.email, dto.email.toLowerCase().trim()),
    });

    if (existing) {
      throw new Error('Email này đã được sử dụng. Vui lòng đăng nhập.');
    }

    const passwordHash = PasswordUtil.hash(dto.password);
    const normalizedEmail = dto.email.toLowerCase().trim();

    // Insert user & profile
    const [newUser] = await db
      .insert(users)
      .values({
        email: normalizedEmail,
        passwordHash,
        status: 'ACTIVE',
      })
      .returning();

    const [newProfile] = await db
      .insert(profiles)
      .values({
        userId: newUser.id,
        nickname: dto.nickname.trim(),
        gender: dto.gender,
        birthDate: dto.birthDate,
        calculatedAge,
        preferredGender: 'ALL',
        preferredAgeMin: 18,
        preferredAgeMax: 30,
        mediaConsentDefault: false,
      })
      .returning();

    const token = JwtUtil.sign(
      { sub: newUser.id, email: newUser.email },
      config.jwtSecret,
      86400
    );

    const privateProfile: UserPrivateProfile = {
      id: newUser.id,
      nickname: newProfile.nickname,
      gender: newProfile.gender as Gender,
      age: calculatedAge,
      preferredGender: newProfile.preferredGender as TargetGender,
      preferredAgeMin: newProfile.preferredAgeMin,
      preferredAgeMax: newProfile.preferredAgeMax,
      mediaConsentDefault: newProfile.mediaConsentDefault,
    };

    return {
      accessToken: token,
      tokenType: 'Bearer',
      expiresIn: 86400,
      profile: privateProfile,
    };
  }

  /**
   * User login with email and password
   */
  async login(dto: LoginDto): Promise<AuthResponse> {
    const normalizedEmail = dto.email.toLowerCase().trim();
    const user = await db.query.users.findFirst({
      where: eq(users.email, normalizedEmail),
    });
    if (!user || !user.passwordHash) {
      throw new Error('Email hoặc mật khẩu không chính xác.');
    }

    if (user.status === 'RESTRICTED' || user.status === 'DELETED') {
      throw new Error('Tài khoản của bạn đã bị khóa hoặc đình chỉ do vi phạm chính sách cộng đồng.');
    }

    const isValid = PasswordUtil.verify(dto.password, user.passwordHash);
    if (!isValid) {
      throw new Error('Email hoặc mật khẩu không chính xác.');
    }

    const profile = await db.query.profiles.findFirst({
      where: eq(profiles.userId, user.id),
    });

    if (!profile) {
      throw new Error('Hồ sơ người dùng không tồn tại.');
    }

    const token = JwtUtil.sign(
      { sub: user.id, email: user.email },
      config.jwtSecret,
      86400
    );

    const calculatedAge = AgeUtil.calculateAge(profile.birthDate);

    const privateProfile: UserPrivateProfile = {
      id: user.id,
      nickname: profile.nickname,
      gender: profile.gender as Gender,
      age: calculatedAge,
      preferredGender: profile.preferredGender as TargetGender,
      preferredAgeMin: profile.preferredAgeMin,
      preferredAgeMax: profile.preferredAgeMax,
      mediaConsentDefault: profile.mediaConsentDefault,
    };

    return {
      accessToken: token,
      tokenType: 'Bearer',
      expiresIn: 86400,
      profile: privateProfile,
    };
  }

  /**
   * Verify Google OAuth ID Token with Google tokeninfo endpoint
   */
  async verifyGoogleIdToken(idToken: string): Promise<{ sub: string; email: string; name?: string }> {
    const googleEnabled = await this.getSystemSetting('auth.google.enabled', 'true');
    if (googleEnabled === 'false') {
      throw new Error('Đăng nhập bằng Google hiện đang tạm tắt bởi Quản trị viên.');
    }

    const clientIdFromDb = await this.getSystemSetting('auth.google.client_id', '');
    const activeClientId = clientIdFromDb.trim() || config.googleClientId;

    if (!activeClientId) {
      throw new Error('Google OAuth chưa được cấu hình.');
    }

    try {
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Xác minh Google Token thất bại';
      throw new Error(`Xác minh tài khoản Google thất bại: ${msg}`, { cause: err });
    }
  }

  /**
   * Google OAuth sign-in / registration with mandatory 18+ check (D02)
   */
  async googleAuth(dto: GoogleAuthDto): Promise<AuthResponse> {
    if (!dto.idToken) {
      throw new Error('Yêu cầu Google ID Token hợp lệ.');
    }

    // Cryptographically verify token with Google's public key endpoint
    const googleVerified = await this.verifyGoogleIdToken(dto.idToken);
    const googleSub = googleVerified.sub;
    const email = googleVerified.email;

    let user = await db.query.users.findFirst({
      where: eq(users.googleSub, googleSub),
    });

    if (user && (user.status === 'RESTRICTED' || user.status === 'DELETED')) {
      throw new Error('Tài khoản của bạn đã bị khóa hoặc đình chỉ do vi phạm chính sách cộng đồng.');
    }
    if (!user) {
      if (!dto.birthDate) {
        throw new Error('Đăng ký lần đầu qua Google bắt buộc phải khai báo ngày sinh 18+.');
      }

      const age = AgeUtil.validateIsAdult(dto.birthDate);

      const [newUser] = await db
        .insert(users)
        .values({
          email,
          googleSub,
          status: 'ACTIVE',
        })
        .returning();

      user = newUser;

      await db.insert(profiles).values({
        userId: user.id,
        nickname: dto.nickname?.trim() || 'Người dùng Google',
        gender: dto.gender || 'OTHER',
        birthDate: dto.birthDate,
        calculatedAge: age,
        preferredGender: 'ALL',
        preferredAgeMin: 18,
        preferredAgeMax: 30,
        mediaConsentDefault: false,
      });
    }

    const profile = await db.query.profiles.findFirst({
      where: eq(profiles.userId, user.id),
    });

    if (!profile) {
      throw new Error('Không tìm thấy hồ sơ người dùng.');
    }

    const token = JwtUtil.sign({ sub: user.id, email: user.email }, config.jwtSecret, 86400);

    return {
      accessToken: token,
      tokenType: 'Bearer',
      expiresIn: 86400,
      profile: {
        id: user.id,
        nickname: profile.nickname,
        gender: profile.gender as Gender,
        age: profile.calculatedAge,
        preferredGender: profile.preferredGender as TargetGender,
        preferredAgeMin: profile.preferredAgeMin,
        preferredAgeMax: profile.preferredAgeMax,
        mediaConsentDefault: profile.mediaConsentDefault,
      },
    };
  }

  /**
   * Get public profile for matching partner (Strictly isolates email, birthDate, IP)
   */
  async getPublicProfile(userId: string): Promise<UserPublicProfile> {
    const profile = await db.query.profiles.findFirst({
      where: eq(profiles.userId, userId),
    });

    if (!profile) {
      throw new Error('Không tìm thấy hồ sơ người dùng.');
    }

    const age = AgeUtil.calculateAge(profile.birthDate);

    return {
      id: profile.userId,
      nickname: profile.nickname,
      gender: profile.gender as Gender,
      age,
    };
  }

  private async assertActiveUser(userId: string): Promise<void> {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });
    if (!user || user.status === 'RESTRICTED' || user.status === 'DELETED') {
      throw new Error('Tài khoản của bạn đã bị khóa hoặc đình chỉ do vi phạm chính sách cộng đồng.');
    }
  }

  /**
   * Get authenticated user's private profile and preferences
   */
  async getMyProfile(userId: string): Promise<UserPrivateProfile> {
    await this.assertActiveUser(userId);
    const profile = await db.query.profiles.findFirst({
      where: eq(profiles.userId, userId),
    });

    if (!profile) {
      throw new Error('Hồ sơ người dùng không tồn tại.');
    }

    const calculatedAge = AgeUtil.calculateAge(profile.birthDate);

    return {
      id: profile.userId,
      nickname: profile.nickname,
      gender: profile.gender as Gender,
      age: calculatedAge,
      preferredGender: profile.preferredGender as TargetGender,
      preferredAgeMin: profile.preferredAgeMin,
      preferredAgeMax: profile.preferredAgeMax,
      mediaConsentDefault: profile.mediaConsentDefault,
    };
  }

  /**
   * Update user profile & matching preferences (S08 / Profile settings)
   */
  async updateProfile(userId: string, dto: UpdateProfileDto): Promise<UserPrivateProfile> {
    await this.assertActiveUser(userId);
    const profile = await db.query.profiles.findFirst({
      where: eq(profiles.userId, userId),
    });
    if (!profile) {
      throw new Error('Hồ sơ người dùng không tồn tại.');
    }

    const updates: Partial<typeof profiles.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (dto.nickname !== undefined) {
      const trimmed = dto.nickname.trim();
      if (!trimmed || trimmed.length > 30) {
        throw new Error('Biệt danh phải từ 1 đến 30 ký tự.');
      }
      updates.nickname = trimmed;
    }

    if (dto.preferredGender !== undefined) {
      if (!['ALL', 'MALE', 'FEMALE', 'OTHER'].includes(dto.preferredGender)) {
        throw new Error('Giới tính ưu tiên không hợp lệ.');
      }
      updates.preferredGender = dto.preferredGender;
    }

    const ageMin = dto.preferredAgeMin ?? profile.preferredAgeMin;
    const ageMax = dto.preferredAgeMax ?? profile.preferredAgeMax;

    if (dto.preferredAgeMin !== undefined || dto.preferredAgeMax !== undefined) {
      if (!Number.isInteger(ageMin) || ageMin < 18 || ageMin > 99) {
        throw new Error('Độ tuổi tối thiểu phải từ 18 trở lên.');
      }
      if (!Number.isInteger(ageMax) || ageMax < ageMin || ageMax > 99) {
        throw new Error('Độ tuổi tối đa phải lớn hơn hoặc bằng độ tuổi tối thiểu.');
      }
      updates.preferredAgeMin = ageMin;
      updates.preferredAgeMax = ageMax;
    }

    if (dto.mediaConsentDefault !== undefined) {
      updates.mediaConsentDefault = Boolean(dto.mediaConsentDefault);
    }

    await db.update(profiles).set(updates).where(eq(profiles.userId, userId));

    const updated = (await db.query.profiles.findFirst({
      where: eq(profiles.userId, userId),
    }))!;

    const calculatedAge = AgeUtil.calculateAge(updated.birthDate);

    return {
      id: userId,
      nickname: updated.nickname,
      gender: updated.gender as Gender,
      age: calculatedAge,
      preferredGender: updated.preferredGender as TargetGender,
      preferredAgeMin: updated.preferredAgeMin,
      preferredAgeMax: updated.preferredAgeMax,
      mediaConsentDefault: updated.mediaConsentDefault,
    };
  }

  /**
   * The vault PIN is a UI privacy lock, not a replacement for account authentication.
   * Only whether a hash exists is returned to clients; the PIN itself never leaves the server.
   */
  async getStealthVaultConfig(userId: string): Promise<StealthVaultConfig> {
    await this.assertActiveUser(userId);
    const profile = await db.query.profiles.findFirst({
      where: eq(profiles.userId, userId),
    });
    if (!profile) throw new Error('Hồ sơ người dùng không tồn tại.');

    return {
      enabled: profile.stealthEnabled,
      hasPin: Boolean(profile.stealthPinHash),
    };
  }

  async updateStealthVault(userId: string, dto: UpdateStealthVaultDto): Promise<StealthVaultConfig> {
    await this.assertActiveUser(userId);
    if (typeof dto?.enabled !== 'boolean') {
      throw new Error('Trạng thái Kho riêng tư không hợp lệ.');
    }

    const profile = await db.query.profiles.findFirst({
      where: eq(profiles.userId, userId),
    });
    if (!profile) throw new Error('Hồ sơ người dùng không tồn tại.');

    if (!dto.enabled) {
      await db
        .update(profiles)
        .set({ stealthEnabled: false, stealthPinHash: null, updatedAt: new Date() })
        .where(eq(profiles.userId, userId));
      return { enabled: false, hasPin: false };
    }

    const pin = dto.pin?.trim();
    if (!pin || !/^\d{4}$/.test(pin)) {
      throw new Error('Mã PIN phải gồm đúng 4 chữ số.');
    }

    if (profile.stealthPinHash) {
      const currentPin = dto.currentPin?.trim();
      if (!currentPin || !PasswordUtil.verify(currentPin, profile.stealthPinHash)) {
        throw new Error('Mã PIN hiện tại không chính xác.');
      }
    }

    await db
      .update(profiles)
      .set({
        stealthEnabled: true,
        stealthPinHash: PasswordUtil.hash(pin),
        updatedAt: new Date(),
      })
      .where(eq(profiles.userId, userId));

    return { enabled: true, hasPin: true };
  }

  async unlockStealthVault(userId: string, pin: string | undefined): Promise<{ message: string }> {
    await this.assertActiveUser(userId);
    const profile = await db.query.profiles.findFirst({
      where: eq(profiles.userId, userId),
    });
    if (!profile || !profile.stealthEnabled || !profile.stealthPinHash) {
      throw new Error('Kho riêng tư chưa được thiết lập.');
    }

    if (!pin || !/^\d{4}$/.test(pin) || !PasswordUtil.verify(pin, profile.stealthPinHash)) {
      throw new Error('Mã PIN không chính xác.');
    }

    return { message: 'Đã mở khóa Kho riêng tư.' };
  }

  /**
   * Request password reset code
   */
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

  /**
   * Reset password with verification code
   */
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

  /**
   * Self-service delete account
   */
  async deleteAccount(userId: string): Promise<{ message: string }> {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) {
      throw new Error('Tài khoản không tồn tại.');
    }

    const now = new Date();

    // Mark as DELETED and scramble credentials
    await db
      .update(users)
      .set({
        status: 'DELETED',
        deletedAt: now,
        updatedAt: now,
      })
      .where(eq(users.id, userId));

    // Anonymize profile
    await db
      .update(profiles)
      .set({
        nickname: 'Người dùng đã xóa',
        updatedAt: now,
      })
      .where(eq(profiles.userId, userId));

    // Clear active friendships to sever social links
    await db
      .delete(friendships)
      .where(or(eq(friendships.user1Id, userId), eq(friendships.user2Id, userId)));

    await db
      .delete(friendRequests)
      .where(or(eq(friendRequests.fromUserId, userId), eq(friendRequests.toUserId, userId)));

    await tokenRevocationStore.revokeUserTokensBefore(userId, Date.now());

    return {
      message: 'Tài khoản của bạn đã được xóa thành công khỏi hệ thống.',
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
      throw new Error('Mật khẩu mới phải có tối thiểu 8 ký tự.');
    }

    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user || user.status === 'RESTRICTED' || user.status === 'DELETED') {
      throw new Error('Tài khoản không tồn tại hoặc đã bị khóa.');
    }

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

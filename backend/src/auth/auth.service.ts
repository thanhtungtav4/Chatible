import { eq, or } from 'drizzle-orm';
import { db } from '../database/index.js';
import { users, profiles } from '../database/schema/users.js';
import { friendRequests, friendships } from '../database/schema/friends.js';
import { systemSettings } from '../database/schema/settings.js';
import { AgeUtil } from './age.util.js';
import { PasswordUtil } from './password.util.js';
import { JwtUtil } from './jwt.util.js';
import { config } from '../config/env.js';
import { MailService } from '../mail/mail.service.js';
import { tokenRevocationStore } from './session-auth.util.js';
import { assertActiveAccount } from './account-status.util.js';
import { AccountRecoveryService } from './account-recovery.service.js';
import { StealthVaultService } from './stealth-vault.service.js';
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
  private readonly recoveryService: AccountRecoveryService;
  private readonly stealthVaultService = new StealthVaultService();

  constructor(private readonly mailService: MailService = new MailService()) {
    this.recoveryService = new AccountRecoveryService(this.mailService);
  }

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
    emailVerificationRequired: boolean;
  }> {
    const googleEnabledStr = await this.getSystemSetting('auth.google.enabled', 'true');
    const googleClientIdDb = await this.getSystemSetting('auth.google.client_id', '');
    const regEnabledStr = await this.getSystemSetting('auth.registration.enabled', 'true');
    const emailVerifReqStr = await this.getSystemSetting('auth.email_verification.required', 'false');

    const googleClientId = googleClientIdDb.trim() || config.googleClientId || '';

    return {
      googleAuthEnabled: googleEnabledStr === 'true' && Boolean(googleClientId),
      googleClientId,
      registrationEnabled: regEnabledStr !== 'false',
      emailVerificationRequired: emailVerifReqStr === 'true',
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
      emailVerified: false,
    };

    // Non-fatal: never fail or delete registration if SMTP fails (AUTH-05)
    await this.recoveryService.issueAndSendEmailVerificationCode(newUser.id, normalizedEmail).catch(() => {});

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
      emailVerified: Boolean(user.emailVerifiedAt),
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
          emailVerifiedAt: new Date(),
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
    } else if (!user.emailVerifiedAt) {
      await db.update(users).set({ emailVerifiedAt: new Date(), updatedAt: new Date() }).where(eq(users.id, user.id));
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
        emailVerified: true,
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

  /**
   * Get authenticated user's private profile and preferences
   */
  async getMyProfile(userId: string): Promise<UserPrivateProfile> {
    const user = await assertActiveAccount(userId);
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
      emailVerified: Boolean(user.emailVerifiedAt),
    };
  }

  /**
   * Update user profile & matching preferences (S08 / Profile settings)
   */
  async updateProfile(userId: string, dto: UpdateProfileDto): Promise<UserPrivateProfile> {
    const user = await assertActiveAccount(userId);
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
      emailVerified: Boolean(user.emailVerifiedAt),
    };
  }

  async resendEmailVerification(userId: string) {
    return this.recoveryService.resendEmailVerification(userId);
  }

  async verifyEmailCode(userId: string, rawCode: string) {
    return this.recoveryService.verifyEmailCode(userId, rawCode);
  }

  async getStealthVaultConfig(userId: string): Promise<StealthVaultConfig> {
    return this.stealthVaultService.getConfig(userId);
  }

  async updateStealthVault(userId: string, dto: UpdateStealthVaultDto): Promise<StealthVaultConfig> {
    return this.stealthVaultService.update(userId, dto);
  }

  async unlockStealthVault(userId: string, pin: string | undefined): Promise<{ message: string }> {
    return this.stealthVaultService.unlock(userId, pin);
  }

  async forgotPassword(email: string): Promise<{ message: string; resetCode?: string }> {
    return this.recoveryService.forgotPassword(email);
  }

  async resetPassword(dto: { email: string; code: string; newPassword: string }): Promise<{ message: string }> {
    return this.recoveryService.resetPassword(dto);
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
    return this.recoveryService.changePassword(userId, dto);
  }
}

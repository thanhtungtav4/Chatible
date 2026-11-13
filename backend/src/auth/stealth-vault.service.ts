import { eq } from 'drizzle-orm';
import type { StealthVaultConfig, UpdateStealthVaultDto } from '@chatible/shared';
import { db } from '../database/index.js';
import { profiles } from '../database/schema/users.js';
import { assertActiveAccount } from './account-status.util.js';
import { PasswordUtil } from './password.util.js';

/**
 * Manages the per-user Stealth Vault PIN lock (enable, disable, rotate, verify).
 */
export class StealthVaultService {
  async getConfig(userId: string): Promise<StealthVaultConfig> {
    await assertActiveAccount(userId);
    const profile = await db.query.profiles.findFirst({
      where: eq(profiles.userId, userId),
    });
    if (!profile) throw new Error('Hồ sơ người dùng không tồn tại.');

    return {
      enabled: profile.stealthEnabled,
      hasPin: Boolean(profile.stealthPinHash),
    };
  }

  async update(userId: string, dto: UpdateStealthVaultDto): Promise<StealthVaultConfig> {
    await assertActiveAccount(userId);
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

  async unlock(userId: string, pin: string | undefined): Promise<{ message: string }> {
    await assertActiveAccount(userId);
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
}

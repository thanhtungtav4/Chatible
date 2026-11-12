/**
 * Stealth Vault Camouflage Types
 */

export interface StealthVaultConfig {
  enabled: boolean;
  hasPin: boolean;
}

export interface UpdateStealthVaultDto {
  enabled: boolean;
  /** Required when enabling for the first time or changing the privacy lock. */
  pin?: string;
  /** Required when replacing an existing privacy lock. */
  currentPin?: string;
}

export interface StealthVaultState {
  isUnlocked: boolean;
  activeScreen: 'screen-chat' | 'screen-friends' | 'screen-recent' | 'screen-profile';
}

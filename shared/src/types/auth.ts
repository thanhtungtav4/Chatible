/**
 * Auth & Profile Contract Types
 * Strictly enforces 18+ policy & isolates sensitive user identity.
 */

export type Gender = 'MALE' | 'FEMALE' | 'OTHER';
export type TargetGender = 'MALE' | 'FEMALE' | 'OTHER' | 'ALL';
export type UserStatus = 'PENDING_VERIF' | 'ACTIVE' | 'RESTRICTED' | 'DELETED';

export interface UserPublicProfile {
  id: string;
  nickname: string;
  gender: Gender;
  age: number; // Publicly displayed age (must be >= 18)
}

export interface UserPrivateProfile extends UserPublicProfile {
  preferredGender: TargetGender;
  preferredAgeMin: number;
  preferredAgeMax: number;
  mediaConsentDefault: boolean;
  emailVerified?: boolean;
}

export interface UserNotificationDto {
  id: string;
  type: 'REPORT_RESOLVED' | 'ACCOUNT_RESTRICTED' | 'APPEAL_DECISION' | 'SYSTEM' | string;
  title: string;
  body: string;
  isRead: boolean;
  relatedResourceId?: string | null;
  createdAt: string;
}

export interface RegisterDto {
  email: string;
  password: string;
  birthDate: string; // YYYY-MM-DD - Server computes age; rejects if < 18
  gender: Gender;
  nickname: string;
  policyAccepted: boolean;
}

export interface LoginDto {
  email: string;
  password: string;
}

export interface GoogleAuthDto {
  idToken: string;
  birthDate?: string; // Required on first Google sign-in
  gender?: Gender;
  nickname?: string;
}

export interface AuthResponse {
  accessToken?: string;
  tokenType?: 'Bearer';
  expiresIn: number;
  profile: UserPrivateProfile;
}

export interface UpdateProfileDto {
  nickname?: string;
  preferredGender?: TargetGender;
  preferredAgeMin?: number;
  preferredAgeMax?: number;
  mediaConsentDefault?: boolean;
}

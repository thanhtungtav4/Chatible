import { UserPublicProfile } from './auth.js';

export type MessageType = 'TEXT' | 'IMAGE' | 'AUDIO' | 'VIDEO';

export type SessionType = 'RANDOM' | 'FRIEND';

export type EndReason = 'USER_LEFT' | 'PARTNER_LEFT' | 'TIMEOUT' | 'BLOCKED' | 'REPORTED';

/**
 * Envelope Encryption Payload Stored in DB
 * DEK is wrapped by Local KMS Master KEK.
 */
export interface EncryptedPayload {
  encryptedDek: string; // Base64 wrapped DEK
  iv: string;           // Base64 12-byte IV for AES-256-GCM
  authTag: string;      // Base64 16-byte Auth Tag
  ciphertext: string;   // Base64 encrypted message body
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  senderId: string;
  isSelf: boolean;
  type: MessageType;
  content: string; // Decrypted plaintext for client display
  metadata?: {
    waveform?: number[]; // 30 audio amplitude points
    durationSec?: number;
    width?: number;
    height?: number;
    thumbnailUrl?: string;
  };
  isAdultContent?: boolean;
  watermarkToken?: string;
  isRevoked?: boolean;
  sentAt: string;
}

export interface SendMessageDto {
  type: MessageType;
  content: string;
  clientMessageId?: string;
  metadata?: Record<string, unknown>;
  isAdultContent?: boolean;
}

export interface ChatSessionSummary {
  id: string;
  type: SessionType;
  partner: UserPublicProfile;
  lastMessageSnippet?: string;
  unreadCount?: number;
  endedAt?: string;
  expiresAt: string; // 7 days for RANDOM, 30 days for FRIEND
}

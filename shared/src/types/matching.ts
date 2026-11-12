import { TargetGender, UserPublicProfile } from './auth.js';

/**
 * 6 Core Conversation Lifecycle States
 */
export type ChatState =
  | 'IDLE'          // S01: Sẵn sàng tìm kiếm
  | 'WAITING'       // S02: Đang trong hàng chờ ghép đôi (Radar animation)
  | 'MATCHING'      // S03: Đã tìm thấy cặp, đang bắt tay kết nối (1.2s)
  | 'CHATTING'      // S04: Cuộc trò chuyện đang diễn ra
  | 'RECONNECTING'   // S05: 1 bên mất mạng, đếm ngược 30s
  | 'ENDED';        // S06: Cuộc trò chuyện đã kết thúc, hiện thanh hành động

export interface MatchFilter {
  targetGender: TargetGender;
  ageMin: number;
  ageMax: number;
}

export interface JoinQueuePayload extends MatchFilter {
  allowFilterExpansion?: boolean;
}

export interface MatchFoundPayload {
  sessionId: string;
  partner: UserPublicProfile;
  matchedAt: string;
}

export interface ReconnectStatusPayload {
  sessionId: string;
  remainingSeconds: number;
  isPartnerReconnecting: boolean;
}

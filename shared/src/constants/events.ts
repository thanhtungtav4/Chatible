/**
 * Realtime WebSocket Event Names for Socket.io
 */
export const SocketEvents = {
  // Matching lifecycle
  MATCHING_JOIN: 'matching:join',
  MATCHING_CANCEL: 'matching:cancel',
  MATCHING_EXPAND_ACCEPT: 'matching:expand_accept',
  MATCHING_FOUND: 'matching:found',
  MATCHING_ERROR: 'matching:error',
  MATCHING_READY: 'matching:ready',

  // Chat conversation
  CHAT_START: 'chat:start',
  CHAT_NEXT: 'chat:next',
  CHAT_END: 'chat:end',
  CHAT_ENDED: 'chat:ended',

  // Messages
  MESSAGE_SEND: 'message:send',
  MESSAGE_RECEIVE: 'message:receive',
  MESSAGE_READ: 'message:read',
  MESSAGE_REVOKE: 'message:revoke',

  // Reconnection 30s
  CONNECTION_LOST: 'connection:lost',
  CONNECTION_RESTORED: 'connection:restored',
  SESSION_RESUME: 'session:resume',

  // Media consent
  MEDIA_CONSENT_REQUEST: 'media:consent_request',
  MEDIA_CONSENT_RESPONSE: 'media:consent_response',
  MEDIA_CONSENT_UPDATE: 'media:consent_update',
  MEDIA_ADULT_CONSENT_UPDATE: 'media:adult_consent_update',
  MEDIA_REVOKED: 'media:revoked',

  // Friendship
  FRIEND_REQUEST_SEND: 'friend:request_send',
  FRIEND_REQUEST_RECEIVED: 'friend:request_received',
  FRIEND_REQUEST_ACCEPT: 'friend:request_accept',
  FRIEND_REQUEST_DECLINED: 'friend:request_declined',
  FRIEND_MESSAGE_RECEIVE: 'friend:message_receive',

  // Groups & Channels
  GROUP_JOIN: 'group:join',
  GROUP_LEAVE: 'group:leave',
  GROUP_MESSAGE_RECEIVE: 'group:message_receive',
} as const;

export type SocketEventName = (typeof SocketEvents)[keyof typeof SocketEvents];

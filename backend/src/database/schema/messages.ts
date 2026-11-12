import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb } from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { chatSessions } from './sessions.js';

export const messages = pgTable('messages', {
  id: uuid('id').defaultRandom().primaryKey(),
  sessionId: uuid('session_id').references(() => chatSessions.id, { onDelete: 'cascade' }).notNull(),
  senderId: uuid('sender_id').references(() => users.id).notNull(),
  clientMessageId: varchar('client_message_id', { length: 64 }),
  messageType: varchar('message_type', { length: 20 }).default('TEXT').notNull(), // TEXT, IMAGE, AUDIO, VIDEO
  
  // Envelope Encryption Storage: DEK is wrapped by Local KMS Master KEK
  encryptedDek: text('encrypted_dek').notNull(), // Base64 wrapped DEK
  iv: text('iv').notNull(),                     // Base64 IV (12 bytes)
  authTag: text('auth_tag').notNull(),          // Base64 Auth Tag (16 bytes)
  ciphertext: text('ciphertext').notNull(),     // Base64 encrypted message content or storage key
  
  metadata: jsonb('metadata'), // Waveform array for audio, dimensions for image
  isAdultContent: boolean('is_adult_content').default(false).notNull(),
  watermarkToken: varchar('watermark_token', { length: 64 }),
  isRevokedBySender: boolean('is_revoked_by_sender').default(false).notNull(),
  
  acceptedAt: timestamp('accepted_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), // 7 days (RANDOM) or 30 days (FRIEND)
});

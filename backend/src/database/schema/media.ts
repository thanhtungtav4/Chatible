import { pgTable, uuid, varchar, text, integer, boolean, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { chatSessions } from './sessions.js';

/** Durable authorization and object-store metadata for encrypted media. */
export const mediaAssets = pgTable('media_assets', {
  id: uuid('id').defaultRandom().primaryKey(),
  sessionId: uuid('session_id').references(() => chatSessions.id, { onDelete: 'cascade' }).notNull(),
  ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  recipientId: uuid('recipient_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  objectKey: text('object_key').notNull().unique(),
  mediaType: varchar('media_type', { length: 20 }).notNull(),
  contentType: varchar('content_type', { length: 255 }).notNull(),
  fileSize: integer('file_size').notNull(),
  // Server-KMS-wrapped media DEK; raw DEK is never stored here.
  encryptedDek: text('encrypted_dek').notNull(),
  iv: text('iv').notNull(),
  authTag: text('auth_tag').notNull(),
  status: varchar('status', { length: 20 }).default('PENDING_UPLOAD').notNull(),
  verifiedMime: varchar('verified_mime', { length: 100 }),
  finalizedAt: timestamp('finalized_at', { withTimezone: true }),
  isAdult: boolean('is_adult').default(false).notNull(),
  senderConfirmed18Plus: boolean('sender_confirmed_18_plus').default(false).notNull(),
  senderConfirmedConsent: boolean('sender_confirmed_consent').default(false).notNull(),
  watermarkToken: varchar('watermark_token', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => [
  index('idx_media_assets_session').on(table.sessionId),
  index('idx_media_assets_recipient').on(table.recipientId),
]);

export const mediaConsents = pgTable('media_consents', {
  id: uuid('id').defaultRandom().primaryKey(),
  sessionId: uuid('session_id').references(() => chatSessions.id, { onDelete: 'cascade' }).notNull(),
  recipientId: uuid('recipient_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  enabled: boolean('enabled').default(false).notNull(),
  grantedAt: timestamp('granted_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('idx_media_consent_session_recipient').on(table.sessionId, table.recipientId),
]);

export const adultConsents = pgTable('adult_consents', {
  id: uuid('id').defaultRandom().primaryKey(),
  sessionId: uuid('session_id').references(() => chatSessions.id, { onDelete: 'cascade' }).notNull(),
  recipientId: uuid('recipient_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  enabled: boolean('enabled').default(false).notNull(),
  policyAcknowledgedAt: timestamp('policy_acknowledged_at', { withTimezone: true }),
  grantedAt: timestamp('granted_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('idx_adult_consent_session_recipient').on(table.sessionId, table.recipientId),
]);

export const mediaViewTokens = pgTable('media_view_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  mediaId: uuid('media_id').references(() => mediaAssets.id, { onDelete: 'cascade' }).notNull(),
  recipientId: uuid('recipient_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
  traceCode: varchar('trace_code', { length: 32 }),
  watermarkText: varchar('watermark_text', { length: 160 }),
  streamKeyWrapped: text('stream_key_wrapped'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => [
  index('idx_media_view_tokens_media').on(table.mediaId),
  index('idx_media_view_tokens_expiry').on(table.expiresAt),
]);

/** Per-recipient cached watermarked variants (for processed video streams). */
export const mediaWatermarkedVariants = pgTable('media_watermarked_variants', {
  id: uuid('id').defaultRandom().primaryKey(),
  mediaId: uuid('media_id').references(() => mediaAssets.id, { onDelete: 'cascade' }).notNull(),
  recipientId: uuid('recipient_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  objectKey: text('object_key').notNull(),
  encryptedDek: text('encrypted_dek').notNull(),
  iv: text('iv').notNull(),
  authTag: text('auth_tag').notNull(),
  contentType: varchar('content_type', { length: 100 }).notNull(),
  fileSize: integer('file_size').notNull(),
  traceCode: varchar('trace_code', { length: 32 }).notNull(),
  watermarkText: varchar('watermark_text', { length: 160 }).notNull(),
  status: varchar('status', { length: 20 }).default('PENDING').notNull(), // PENDING, PROCESSING, READY, FAILED
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (table) => [
  uniqueIndex('idx_media_wm_variant_unique').on(table.mediaId, table.recipientId),
  index('idx_media_wm_variant_expiry').on(table.expiresAt),
]);

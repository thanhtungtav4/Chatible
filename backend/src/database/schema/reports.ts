import { pgTable, uuid, varchar, text, timestamp, boolean, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { chatSessions } from './sessions.js';
import { communityRooms } from './groups.js';

export const reports = pgTable('reports', {
  id: uuid('id').defaultRandom().primaryKey(),
  sessionId: uuid('session_id').references(() => chatSessions.id, { onDelete: 'set null' }),
  roomId: uuid('room_id').references(() => communityRooms.id, { onDelete: 'set null' }),
  reporterId: uuid('reporter_id').references(() => users.id).notNull(),
  reportedUserId: uuid('reported_user_id').references(() => users.id).notNull(),
  reason: varchar('reason', { length: 50 }).notNull(), // UNDERAGE, HARASSMENT, NONCONSENSUAL_MEDIA, THREAT, SPAM, OTHER
  description: text('description'),
  priority: varchar('priority', { length: 20 }).default('MEDIUM').notNull(), // URGENT, HIGH, MEDIUM, LOW
  status: varchar('status', { length: 20 }).default('OPEN').notNull(), // OPEN, IN_REVIEW, RESOLVED, DISMISSED
  resolutionConclusion: varchar('resolution_conclusion', { length: 50 }), // ACTION_TAKEN, DISMISSED, NO_VIOLATION
  adminNote: text('admin_note'),
  resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }), // Set to 90 days after closure
});

export const reportEvidence = pgTable('report_evidence', {
  id: uuid('id').defaultRandom().primaryKey(),
  reportId: uuid('report_id').references(() => reports.id, { onDelete: 'cascade' }).notNull(),
  messageId: uuid('message_id'),
  groupMessageId: uuid('group_message_id'),
  frozenEncryptedDek: text('frozen_encrypted_dek').notNull(),
  frozenCiphertext: text('frozen_ciphertext').notNull(),
  iv: text('iv').notNull(),
  authTag: text('auth_tag').notNull(),
  messageType: varchar('message_type', { length: 20 }).default('TEXT').notNull(),
  frozenAt: timestamp('frozen_at', { withTimezone: true }).defaultNow().notNull(),
});

export const restrictionAppeals = pgTable('restriction_appeals', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  reason: text('reason').notNull(),
  status: varchar('status', { length: 20 }).default('PENDING').notNull(), // PENDING, APPROVED, REJECTED
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
  adminNote: text('admin_note'),
});

export const userNotifications = pgTable(
  'user_notifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
    type: varchar('type', { length: 50 }).notNull(), // REPORT_RESOLVED, ACCOUNT_RESTRICTED, APPEAL_DECISION, SYSTEM
    title: varchar('title', { length: 160 }).notNull(),
    body: text('body').notNull(),
    relatedResourceId: uuid('related_resource_id'),
    isRead: boolean('is_read').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_user_notifications_user_created').on(table.userId, table.createdAt)]
);

import { pgTable, uuid, varchar, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const chatSessions = pgTable('chat_sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  sessionType: varchar('session_type', { length: 20 }).default('RANDOM').notNull(), // RANDOM, FRIEND
  userAId: uuid('user_a_id').references(() => users.id).notNull(),
  userBId: uuid('user_b_id').references(() => users.id).notNull(),
  status: varchar('status', { length: 20 }).default('ACTIVE').notNull(), // ACTIVE, RECONNECTING, ENDED
  endReason: varchar('end_reason', { length: 30 }), // USER_LEFT, PARTNER_LEFT, TIMEOUT, BLOCKED, REPORTED
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), // 7 days after ended for RANDOM
});

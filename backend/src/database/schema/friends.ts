import { pgTable, uuid, varchar, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

export const friendships = pgTable(
  'friendships',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    user1Id: uuid('user_1_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
    user2Id: uuid('user_2_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
    status: varchar('status', { length: 20 }).default('ACCEPTED').notNull(),
    establishedAt: timestamp('established_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Unique index to prevent duplicate reverse relationships (A-B and B-A)
    uniqueIndex('idx_unique_friendship_pair').on(
      sql`LEAST(${table.user1Id}, ${table.user2Id}), GREATEST(${table.user1Id}, ${table.user2Id})`
    ),
  ]
);

export const friendRequests = pgTable('friend_requests', {
  id: uuid('id').defaultRandom().primaryKey(),
  fromUserId: uuid('from_user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  toUserId: uuid('to_user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  status: varchar('status', { length: 20 }).default('PENDING').notNull(), // PENDING, ACCEPTED, DECLINED, CANCELLED
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const blockedUsers = pgTable(
  'blocked_users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    blockerId: uuid('blocker_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
    blockedId: uuid('blocked_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_unique_block_pair').on(table.blockerId, table.blockedId),
  ]
);

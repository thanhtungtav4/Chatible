import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const communityRooms = pgTable('community_rooms', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 80 }).notNull(),
  description: varchar('description', { length: 255 }),
  type: varchar('type', { length: 24 }).notNull(), // BROADCAST, PUBLIC, PRIVATE_PASSCODE
  passcodeHash: varchar('passcode_hash', { length: 255 }),
  createdBy: uuid('created_by').references(() => users.id).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const communityMembers = pgTable(
  'community_members',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    roomId: uuid('room_id').references(() => communityRooms.id, { onDelete: 'cascade' }).notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
    role: varchar('role', { length: 20 }).default('MEMBER').notNull(), // ADMIN, MEMBER
    passcodeVerifiedAt: timestamp('passcode_verified_at', { withTimezone: true }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex('idx_community_member_room_user').on(table.roomId, table.userId)]
);

export const communityMessages = pgTable(
  'community_messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    roomId: uuid('room_id').references(() => communityRooms.id, { onDelete: 'cascade' }).notNull(),
    senderId: uuid('sender_id').references(() => users.id).notNull(),
    messageType: varchar('message_type', { length: 20 }).default('TEXT').notNull(),
    encryptedDek: text('encrypted_dek').notNull(),
    iv: text('iv').notNull(),
    authTag: text('auth_tag').notNull(),
    ciphertext: text('ciphertext').notNull(),
    metadata: jsonb('metadata'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('idx_community_messages_room').on(table.roomId, table.acceptedAt)]
);

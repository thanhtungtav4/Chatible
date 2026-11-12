import { pgTable, uuid, varchar, timestamp, bigserial, jsonb } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  seq: bigserial('seq', { mode: 'number' }).notNull(),
  actorId: uuid('actor_id').references(() => users.id).notNull(), // Super Admin user ID
  action: varchar('action', { length: 50 }).notNull(),
  targetResourceId: uuid('target_resource_id').notNull(),
  ipAddress: varchar('ip_address', { length: 45 }),
  details: jsonb('details'),
  prevHash: varchar('prev_hash', { length: 64 }),
  entryHash: varchar('entry_hash', { length: 64 }),
  timestamp: timestamp('timestamp', { withTimezone: true }).defaultNow().notNull(),
});

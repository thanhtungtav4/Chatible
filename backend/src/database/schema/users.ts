import { pgTable, uuid, varchar, timestamp, date, integer, boolean } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }),
  googleSub: varchar('google_sub', { length: 255 }),
  status: varchar('status', { length: 32 }).default('ACTIVE').notNull(),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const profiles = pgTable('profiles', {
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).primaryKey(),
  nickname: varchar('nickname', { length: 30 }).notNull(),
  gender: varchar('gender', { length: 10 }).notNull(), // MALE, FEMALE, OTHER
  birthDate: date('birth_date').notNull(), // Private
  calculatedAge: integer('calculated_age').notNull(),

  preferredGender: varchar('preferred_gender', { length: 10 }).default('ALL').notNull(),
  preferredAgeMin: integer('preferred_age_min').default(18).notNull(),
  preferredAgeMax: integer('preferred_age_max').default(30).notNull(),
  mediaConsentDefault: boolean('media_consent_default').default(false).notNull(),
  // A convenience privacy lock for the recent-sessions screen. Never store its PIN in plaintext.
  stealthEnabled: boolean('stealth_enabled').default(false).notNull(),
  stealthPinHash: varchar('stealth_pin_hash', { length: 255 }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  tokenHash: varchar('token_hash', { length: 255 }).notNull(),
  code: varchar('code', { length: 10 }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const emailVerificationTokens = pgTable('email_verification_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  email: varchar('email', { length: 255 }).notNull(),
  codeHash: varchar('code_hash', { length: 128 }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

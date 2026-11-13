import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from '../config/env.js';
import * as usersSchema from './schema/users.js';
import * as sessionsSchema from './schema/sessions.js';
import * as messagesSchema from './schema/messages.js';
import * as friendsSchema from './schema/friends.js';
import * as reportsSchema from './schema/reports.js';
import * as auditSchema from './schema/audit.js';
import * as mediaSchema from './schema/media.js';
import * as settingsSchema from './schema/settings.js';
import * as groupsSchema from './schema/groups.js';

export const schema = {
  ...usersSchema,
  ...sessionsSchema,
  ...messagesSchema,
  ...friendsSchema,
  ...reportsSchema,
  ...auditSchema,
  ...mediaSchema,
  ...settingsSchema,
  ...groupsSchema,
};

const defaultPoolMax = config.nodeEnv === 'production' ? 4 : 10;
const parsedPoolMax = Number.parseInt(process.env.DB_POOL_MAX || '', 10);
const poolMax = Number.isFinite(parsedPoolMax) && parsedPoolMax >= 1 ? parsedPoolMax : defaultPoolMax;

const queryClient = postgres(config.databaseUrl, {
  max: poolMax,
  idle_timeout: 20,
  max_lifetime: 1800,
  connect_timeout: 10,
});
export const db = drizzle(queryClient, { schema });

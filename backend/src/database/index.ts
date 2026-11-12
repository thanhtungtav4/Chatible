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

const queryClient = postgres(config.databaseUrl);
export const db = drizzle(queryClient, { schema });

import dotenv from 'dotenv';
import { defineConfig } from 'drizzle-kit';

dotenv.config();
dotenv.config({ path: '../.env' });

const databaseUrl = process.env.DATABASE_URL || 'postgresql://macbook@localhost:5432/chatible_db';
if (!databaseUrl) {
  throw new Error('DATABASE_URL must be configured before running Drizzle migrations.');
}

export default defineConfig({
  schema: './src/database/schema/*.ts',
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: databaseUrl,
  },
});

import 'dotenv/config';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

const DB_PATH = resolve(process.env.DATABASE_URL ?? './data/app.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

function createDb() {
  const sqlite = new Database(DB_PATH);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000'); // wait up to 5s when write-locked
  return drizzle(sqlite, { schema });
}

// Survive Next.js HMR in dev: module cache can be invalidated but globalThis persists.
const globalForDb = globalThis as unknown as {
  db: BetterSQLite3Database<typeof schema> | undefined;
};

export const db = globalForDb.db ?? createDb();

if (process.env.NODE_ENV !== 'production') {
  globalForDb.db = db;
}

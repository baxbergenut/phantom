import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import * as schema from './schema.js';

const defaultMigrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));
const defaultDatabasePath = fileURLToPath(new URL('../../../../data/phantom.db', import.meta.url));

export type PhantomDatabase = ReturnType<typeof openDatabase>;

export function resolveDatabasePath(databasePath?: string): string {
  return path.resolve(databasePath || process.env.PHANTOM_DATABASE_PATH || defaultDatabasePath);
}

export function openDatabase(databasePath?: string, migrationsFolder = defaultMigrationsFolder) {
  const resolvedPath = resolveDatabasePath(databasePath);
  mkdirSync(path.dirname(resolvedPath), { recursive: true });

  const sqlite = new Database(resolvedPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });

  return { db, sqlite, path: resolvedPath };
}

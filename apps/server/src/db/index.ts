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
  repairSkippedPhaseMigrations(sqlite);

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });

  return { db, sqlite, path: resolvedPath };
}

export function repairSkippedPhaseMigrations(sqlite: Database.Database): void {
  const hasExecutions = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'executions'")
    .get();
  if (!hasExecutions) return;
  const columns = new Set(
    (sqlite.prepare('PRAGMA table_info(executions)').all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  const additions = [
    ['codex_thread_id', 'text'],
    ['retry_count', 'integer DEFAULT 0 NOT NULL CHECK (`retry_count` >= 0)'],
    ['final_result', 'text'],
    ['token_usage', 'text'],
    ['raw_log_path', 'text'],
    ['starting_head', 'text'],
    ['starting_remote_sha', 'text'],
    ['ending_head', 'text'],
    ['ending_remote_sha', 'text'],
    ['changed_files', 'text'],
    ['commit_metadata', 'text'],
  ] as const;

  sqlite.transaction(() => {
    for (const [name, definition] of additions) {
      if (!columns.has(name)) sqlite.exec(`ALTER TABLE executions ADD \`${name}\` ${definition}`);
    }
    sqlite.exec(`CREATE TABLE IF NOT EXISTS execution_events (
      id text PRIMARY KEY NOT NULL,
      execution_id text NOT NULL,
      sequence integer NOT NULL,
      kind text NOT NULL CHECK (kind IN ('thread', 'progress', 'command', 'file_change', 'usage', 'failure', 'final')),
      message text NOT NULL,
      metadata text,
      created_at text NOT NULL,
      FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE cascade
    )`);
    sqlite.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS execution_events_execution_sequence_unique ON execution_events (execution_id, sequence)',
    );
    sqlite.exec(
      'CREATE INDEX IF NOT EXISTS execution_events_execution_created_idx ON execution_events (execution_id, created_at)',
    );
  })();
}

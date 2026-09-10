import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { repairSkippedPhaseMigrations } from './index.js';

describe('legacy migration repair', () => {
  it('fills skipped Phase 3 and 4 schema idempotently', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`CREATE TABLE executions (
      id text PRIMARY KEY NOT NULL,
      retry_count integer DEFAULT 7
    )`);

    repairSkippedPhaseMigrations(sqlite);
    repairSkippedPhaseMigrations(sqlite);

    const columns = (
      sqlite.prepare('PRAGMA table_info(executions)').all() as Array<{ name: string }>
    ).map((column) => column.name);
    expect(columns).toEqual(
      expect.arrayContaining([
        'codex_thread_id',
        'retry_count',
        'final_result',
        'raw_log_path',
        'starting_head',
        'commit_metadata',
      ]),
    );
    expect(
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'execution_events'",
        )
        .get(),
    ).toBeTruthy();
    sqlite.close();
  });
});

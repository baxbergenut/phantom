import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type PhantomDatabase } from './db/index.js';
import { FakeExecutor, type FakeScenario, type TaskExecutor } from './fake-executor.js';
import { Scheduler } from './scheduler.js';
import {
  allowedTaskTransitions,
  InvalidTaskTransitionError,
  transitionTask,
} from './task-state.js';

describe('task transition rules', () => {
  it('defines terminal states and valid scheduler transitions', () => {
    expect(allowedTaskTransitions.completed).toEqual([]);
    expect(allowedTaskTransitions.queued).toContain('running');
    expect(allowedTaskTransitions.failed).toContain('queued');
  });
});

describe('persistent scheduler', () => {
  let root: string;
  let databasePath: string;
  let database: PhantomDatabase;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'phantom-scheduler-'));
    databasePath = path.join(root, 'phantom.db');
    database = openDatabase(databasePath);
    insertProject(database, 'enabled', true);
  });

  afterEach(() => {
    database.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('runs enabled tasks in priority and FIFO order', async () => {
    insertTask(database, 'normal-old', 'normal', '2026-01-01T00:00:00.000Z');
    insertTask(database, 'urgent-new', 'urgent', '2026-01-03T00:00:00.000Z');
    insertTask(database, 'urgent-old', 'urgent', '2026-01-02T00:00:00.000Z');
    insertProject(database, 'disabled', false);
    insertTask(database, 'disabled-urgent', 'urgent', '2026-01-01T00:00:00.000Z', 'disabled');
    const order: string[] = [];
    const executor = new FakeExecutor((task) => {
      order.push(task.id);
      return { outcome: 'success', delayMs: 0 };
    });
    const scheduler = new Scheduler(database, { executor });

    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();
    expect(order).toEqual(['urgent-old', 'urgent-new', 'normal-old']);
    expect(taskStatus(database, 'disabled-urgent')).toBe('queued');
    expect(eventStatuses(database, 'normal-old')).toEqual(['running', 'completed']);
  });

  it('allows only one acquisition across overlapping workers and ticks', async () => {
    insertTask(database, 'only-task', 'normal', '2026-01-01T00:00:00.000Z');
    const secondDatabase = openDatabase(databasePath);
    let active = 0;
    let maximumActive = 0;
    let starts = 0;
    const executor = new FakeExecutor(() => {
      starts += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      return { outcome: 'success', delayMs: 30 };
    });
    const wrappedExecutor = {
      async execute(context: Parameters<FakeExecutor['execute']>[0]) {
        try {
          return await executor.execute(context);
        } finally {
          active -= 1;
        }
      },
    };
    const first = new Scheduler(database, { workerId: 'worker-a', executor: wrappedExecutor });
    const second = new Scheduler(secondDatabase, {
      workerId: 'worker-b',
      executor: wrappedExecutor,
    });

    await Promise.all([first.tick(), first.tick(), second.tick()]);
    expect(starts).toBe(1);
    expect(maximumActive).toBe(1);
    expect(executionCount(database, 'only-task')).toBe(1);
    secondDatabase.sqlite.close();
  });

  it('respects the durable pause flag', async () => {
    insertTask(database, 'paused-task', 'normal', '2026-01-01T00:00:00.000Z');
    database.sqlite.prepare("UPDATE settings SET value = 'true' WHERE key = 'worker.paused'").run();
    const scheduler = new Scheduler(database);

    expect(await scheduler.tick()).toBe(false);
    expect(taskStatus(database, 'paused-task')).toBe('queued');
    database.sqlite
      .prepare("UPDATE settings SET value = 'false' WHERE key = 'worker.paused'")
      .run();
    expect(await scheduler.tick()).toBe(true);
    expect(taskStatus(database, 'paused-task')).toBe('completed');
  });

  it('recovers a stale crash using the same execution and attempt', async () => {
    insertTask(database, 'crash-task', 'high', '2026-01-01T00:00:00.000Z');
    let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    const scenarios = (task: { recoveryCount: number }): FakeScenario =>
      task.recoveryCount === 0
        ? { outcome: 'crash', delayMs: 0 }
        : { outcome: 'success', delayMs: 0 };
    const first = new Scheduler(database, {
      workerId: 'crashed-worker',
      executor: new FakeExecutor(scenarios),
      config: { staleAfterMs: 50, leaseDurationMs: 20 },
      now: () => new Date(nowMs),
    });
    await first.tick();
    expect(taskStatus(database, 'crash-task')).toBe('running');

    nowMs += 100;
    const recovered = new Scheduler(database, {
      workerId: 'recovery-worker',
      executor: new FakeExecutor(scenarios),
      config: { staleAfterMs: 50, leaseDurationMs: 20 },
      now: () => new Date(nowMs),
    });
    await recovered.tick();

    expect(taskStatus(database, 'crash-task')).toBe('completed');
    const run = database.sqlite
      .prepare(
        'SELECT attempt_number AS attemptNumber, recovery_count AS recoveryCount, state FROM executions',
      )
      .get() as { attemptNumber: number; recoveryCount: number; state: string };
    expect(run).toEqual({ attemptNumber: 1, recoveryCount: 1, state: 'completed' });
    expect(executionCount(database, 'crash-task')).toBe(1);
  });

  it('records graceful shutdown as resumable without duplicating the attempt', async () => {
    insertTask(database, 'shutdown-task', 'normal', '2026-01-01T00:00:00.000Z');
    const first = new Scheduler(database, {
      executor: new FakeExecutor(() => ({ outcome: 'success', delayMs: 10_000 })),
    });
    const runningTick = first.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await first.stop();
    await runningTick;
    expect(taskStatus(database, 'shutdown-task')).toBe('running');
    expect(executionState(database, 'shutdown-task')).toBe('recovering');

    const second = new Scheduler(database, {
      executor: new FakeExecutor(() => ({ outcome: 'success', delayMs: 0 })),
    });
    await second.tick();
    expect(taskStatus(database, 'shutdown-task')).toBe('completed');
    expect(executionCount(database, 'shutdown-task')).toBe(1);
  });

  it('persists Codex thread, retry, events, usage, and structured final result', async () => {
    insertTask(database, 'codex-task', 'normal', '2026-01-01T00:00:00.000Z');
    const finalResult = {
      schemaVersion: 1 as const,
      status: 'completed' as const,
      summary: 'Implemented and verified.',
      completedItems: ['Implementation', 'Tests'],
      incompleteItems: [],
      failureCategory: 'none' as const,
      failureReason: null,
      retryRecommended: false,
      commitSha: null,
      pushed: false,
    };
    const executor: TaskExecutor = {
      async execute(context) {
        context.setThreadId('0199-persisted-thread');
        context.reportEvent('progress', 'Inspecting files.');
        context.beginRetry('The first result was malformed.');
        context.reportEvent('usage', 'Retry completed.', { inputTokens: 10, outputTokens: 5 });
        return {
          status: 'completed',
          reason: finalResult.summary,
          finalResult,
          tokenUsage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
          rawLogPath: 'C:\\logs\\execution.jsonl',
        };
      },
    };
    await new Scheduler(database, { executor }).tick();

    expect(eventStatuses(database, 'codex-task')).toEqual([
      'running',
      'retrying',
      'running',
      'completed',
    ]);
    const execution = database.sqlite
      .prepare(
        `SELECT codex_thread_id AS codexThreadId, retry_count AS retryCount,
                final_result AS finalResult, token_usage AS tokenUsage, raw_log_path AS rawLogPath
         FROM executions WHERE task_id = ?`,
      )
      .get('codex-task') as {
      codexThreadId: string;
      retryCount: number;
      finalResult: string;
      tokenUsage: string;
      rawLogPath: string;
    };
    expect(execution.codexThreadId).toBe('0199-persisted-thread');
    expect(execution.retryCount).toBe(1);
    expect(JSON.parse(execution.finalResult)).toEqual(finalResult);
    expect(JSON.parse(execution.tokenUsage)).toMatchObject({ outputTokens: 5 });
    expect(execution.rawLogPath).toContain('execution.jsonl');
    expect(
      (
        database.sqlite
          .prepare(
            'SELECT COUNT(*) AS count FROM execution_events WHERE execution_id IN (SELECT id FROM executions WHERE task_id = ?)',
          )
          .get('codex-task') as { count: number }
      ).count,
    ).toBe(3);
  });

  it('rejects invalid transitions without recording an event', () => {
    insertTask(database, 'state-task', 'normal', '2026-01-01T00:00:00.000Z');
    expect(() =>
      transitionTask(database.sqlite, {
        taskId: 'state-task',
        newStatus: 'completed',
        reason: 'Invalid shortcut.',
      }),
    ).toThrow(InvalidTaskTransitionError);
    expect(eventCount(database, 'state-task')).toBe(0);
  });
});

function insertProject(database: PhantomDatabase, id: string, enabled: boolean) {
  const now = '2026-01-01T00:00:00.000Z';
  database.sqlite
    .prepare(
      `INSERT INTO projects
       (id, name, local_path, remote_name, remote_branch, enabled, validation_commands, created_at, updated_at)
       VALUES (?, ?, ?, 'origin', 'main', ?, '[]', ?, ?)`,
    )
    .run(id, id, `C:\\${id}`, enabled ? 1 : 0, now, now);
}

function insertTask(
  database: PhantomDatabase,
  id: string,
  priority: string,
  createdAt: string,
  projectId = 'enabled',
) {
  database.sqlite
    .prepare(
      `INSERT INTO tasks
       (id, project_id, title, instructions, priority, status, attempt_count, created_at, updated_at)
       VALUES (?, ?, ?, 'test', ?, 'queued', 0, ?, ?)`,
    )
    .run(id, projectId, id, priority, createdAt, createdAt);
}

function taskStatus(database: PhantomDatabase, id: string): string {
  return (
    database.sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as { status: string }
  ).status;
}

function executionCount(database: PhantomDatabase, taskId: string): number {
  return (
    database.sqlite
      .prepare('SELECT COUNT(*) AS count FROM executions WHERE task_id = ?')
      .get(taskId) as {
      count: number;
    }
  ).count;
}

function executionState(database: PhantomDatabase, taskId: string): string {
  return (
    database.sqlite.prepare('SELECT state FROM executions WHERE task_id = ?').get(taskId) as {
      state: string;
    }
  ).state;
}

function eventCount(database: PhantomDatabase, taskId: string): number {
  return (
    database.sqlite
      .prepare('SELECT COUNT(*) AS count FROM task_events WHERE task_id = ?')
      .get(taskId) as {
      count: number;
    }
  ).count;
}

function eventStatuses(database: PhantomDatabase, taskId: string): string[] {
  return (
    database.sqlite
      .prepare('SELECT new_status AS newStatus FROM task_events WHERE task_id = ? ORDER BY rowid')
      .all(taskId) as Array<{ newStatus: string }>
  ).map((event) => event.newStatus);
}

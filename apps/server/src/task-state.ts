import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { TaskStatus } from '@phantom/shared';

export const allowedTaskTransitions: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ['classifying', 'running', 'blocked'],
  classifying: ['queued', 'waiting_quota', 'running', 'failed', 'blocked'],
  waiting_quota: ['classifying', 'running', 'blocked'],
  running: ['queued', 'waiting_quota', 'retrying', 'completed', 'failed', 'blocked'],
  retrying: ['running', 'waiting_quota', 'completed', 'failed', 'blocked'],
  completed: [],
  failed: ['queued', 'retrying'],
  blocked: ['queued'],
};

export class InvalidTaskTransitionError extends Error {
  constructor(previousStatus: TaskStatus, newStatus: TaskStatus) {
    super(`Invalid task transition: ${previousStatus} -> ${newStatus}.`);
  }
}

interface TransitionInput {
  taskId: string;
  newStatus: TaskStatus;
  reason: string;
  statusReason?: string | null;
  executionId?: string | null;
  correlationId?: string;
  now?: string;
  expectedStatus?: TaskStatus;
}

interface TaskStatusRow {
  status: TaskStatus;
}

export function transitionTaskInTransaction(
  sqlite: Database.Database,
  input: TransitionInput,
): void {
  const task = sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get(input.taskId) as
    TaskStatusRow | undefined;
  if (!task) throw new Error(`Task ${input.taskId} does not exist.`);
  if (input.expectedStatus && task.status !== input.expectedStatus) {
    throw new InvalidTaskTransitionError(task.status, input.newStatus);
  }
  if (!allowedTaskTransitions[task.status].includes(input.newStatus)) {
    throw new InvalidTaskTransitionError(task.status, input.newStatus);
  }

  const now = input.now ?? new Date().toISOString();
  sqlite
    .prepare('UPDATE tasks SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?')
    .run(
      input.newStatus,
      input.statusReason === undefined ? input.reason || null : input.statusReason,
      now,
      input.taskId,
    );
  sqlite
    .prepare(
      `INSERT INTO task_events
        (id, task_id, execution_id, previous_status, new_status, reason, correlation_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      input.taskId,
      input.executionId ?? null,
      task.status,
      input.newStatus,
      input.reason,
      input.correlationId ?? randomUUID(),
      now,
    );
}

export function transitionTask(sqlite: Database.Database, input: TransitionInput): void {
  sqlite.transaction(() => transitionTaskInTransaction(sqlite, input)).immediate();
}

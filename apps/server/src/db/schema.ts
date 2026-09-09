import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import type { ExecutionState, TaskPriority, TaskStatus } from '@phantom/shared';

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    localPath: text('local_path').notNull(),
    remoteName: text('remote_name').notNull().default('origin'),
    remoteBranch: text('remote_branch').notNull().default('main'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    validationCommands: text('validation_commands', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default([]),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [uniqueIndex('projects_local_path_unique').on(table.localPath)],
);

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    instructions: text('instructions').notNull(),
    priority: text('priority').$type<TaskPriority>().notNull().default('normal'),
    status: text('status').$type<TaskStatus>().notNull().default('queued'),
    attemptCount: integer('attempt_count').notNull().default(0),
    statusReason: text('status_reason'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('tasks_queue_order_idx').on(table.status, table.priority, table.createdAt),
    index('tasks_project_idx').on(table.projectId),
    check('tasks_priority_check', sql`${table.priority} IN ('urgent', 'high', 'normal', 'low')`),
    check(
      'tasks_status_check',
      sql`${table.status} IN ('queued', 'classifying', 'waiting_quota', 'running', 'retrying', 'completed', 'failed', 'blocked')`,
    ),
    check('tasks_attempt_count_check', sql`${table.attemptCount} >= 0`),
  ],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const executions = sqliteTable(
  'executions',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    attemptNumber: integer('attempt_number').notNull(),
    state: text('state').$type<ExecutionState>().notNull(),
    workerId: text('worker_id'),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
    heartbeatAt: text('heartbeat_at').notNull(),
    recoveryCount: integer('recovery_count').notNull().default(0),
    recoveryMetadata: text('recovery_metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('executions_task_attempt_unique').on(table.taskId, table.attemptNumber),
    index('executions_state_heartbeat_idx').on(table.state, table.heartbeatAt),
    check(
      'executions_state_check',
      sql`${table.state} IN ('running', 'recovering', 'completed', 'failed')`,
    ),
    check('executions_attempt_number_check', sql`${table.attemptNumber} > 0`),
    check('executions_recovery_count_check', sql`${table.recoveryCount} >= 0`),
  ],
);

export const taskEvents = sqliteTable(
  'task_events',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    executionId: text('execution_id').references(() => executions.id, { onDelete: 'set null' }),
    previousStatus: text('previous_status').$type<TaskStatus>(),
    newStatus: text('new_status').$type<TaskStatus>().notNull(),
    reason: text('reason').notNull(),
    correlationId: text('correlation_id').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('task_events_task_created_idx').on(table.taskId, table.createdAt)],
);

export const workerLease = sqliteTable('worker_lease', {
  key: text('key').primaryKey(),
  workerId: text('worker_id'),
  executionId: text('execution_id').references(() => executions.id, { onDelete: 'set null' }),
  leaseExpiresAt: text('lease_expires_at'),
  heartbeatAt: text('heartbeat_at'),
  lastPollAt: text('last_poll_at'),
  shuttingDown: integer('shutting_down', { mode: 'boolean' }).notNull().default(false),
  updatedAt: text('updated_at').notNull(),
});

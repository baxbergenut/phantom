import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import type { TaskPriority, TaskStatus } from '@phantom/shared';

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

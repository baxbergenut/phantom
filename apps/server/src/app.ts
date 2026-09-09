import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import {
  projectInputSchema,
  projectEnabledPatchSchema,
  projectPatchSchema,
  taskInputSchema,
  taskListQuerySchema,
  taskPatchSchema,
  taskPriorityPatchSchema,
  workerSettingPatchSchema,
} from '@phantom/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import Fastify from 'fastify';

import { openDatabase } from './db/index.js';
import { projects, settings, tasks } from './db/schema.js';
import { HttpError, parseBody } from './http.js';
import { ProjectPathError, validateProjectPath } from './project-validation.js';

interface AppOptions {
  databasePath?: string;
  dashboardRoot?: string | false;
  migrationsFolder?: string;
  logger?: boolean;
}

const workerPausedKey = 'worker.paused';
const defaultDashboardRoot = fileURLToPath(new URL('../../dashboard/dist', import.meta.url));

export async function createApp(options: AppOptions = {}) {
  const database = openDatabase(options.databasePath, options.migrationsFolder);
  const app = Fastify({ logger: options.logger ?? false });

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('Only localhost origins are allowed.'), false);
    },
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({
        error: error.message,
        ...(error.details ? { details: error.details } : {}),
      });
    }
    if (error instanceof ProjectPathError) {
      return reply.status(400).send({ error: error.message });
    }
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
      return reply.status(409).send({ error: 'A project with this local path already exists.' });
    }
    app.log.error(error);
    return reply.status(500).send({ error: 'An unexpected server error occurred.' });
  });

  app.addHook('onClose', () => {
    database.sqlite.close();
  });

  app.get('/api/health', () => {
    database.sqlite.prepare('SELECT 1').get();
    return { status: 'ok', database: 'connected', timestamp: new Date().toISOString() };
  });

  app.get('/api/version', () => ({ name: 'phantom', version: '0.1.0', phase: 1 }));

  app.get('/api/projects', () =>
    database.db.select().from(projects).orderBy(asc(projects.name)).all(),
  );

  app.post('/api/projects', async (request, reply) => {
    const input = parseBody(projectInputSchema, request.body);
    const localPath = await validateProjectPath(input.localPath);
    const now = new Date().toISOString();
    const project = { ...input, id: randomUUID(), localPath, createdAt: now, updatedAt: now };
    database.db.insert(projects).values(project).run();
    return reply.status(201).send(project);
  });

  app.patch('/api/projects/:id', async (request) => {
    const { id } = request.params as { id: string };
    const input = parseBody(projectPatchSchema, request.body);
    const existing = database.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!existing) throw new HttpError(404, 'Project not found.');

    const localPath = input.localPath
      ? await validateProjectPath(input.localPath)
      : existing.localPath;
    database.db
      .update(projects)
      .set({ ...input, localPath, updatedAt: new Date().toISOString() })
      .where(eq(projects.id, id))
      .run();
    return database.db.select().from(projects).where(eq(projects.id, id)).get();
  });

  app.patch('/api/projects/:id/enabled', async (request) => {
    const { id } = request.params as { id: string };
    const { enabled } = parseBody(projectEnabledPatchSchema, request.body);
    const project = database.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!project) throw new HttpError(404, 'Project not found.');
    database.db
      .update(projects)
      .set({ enabled, updatedAt: new Date().toISOString() })
      .where(eq(projects.id, id))
      .run();
    return database.db.select().from(projects).where(eq(projects.id, id)).get();
  });

  app.delete('/api/projects/:id', (request, reply) => {
    const { id } = request.params as { id: string };
    const result = database.db.delete(projects).where(eq(projects.id, id)).run();
    if (result.changes === 0) throw new HttpError(404, 'Project not found.');
    return reply.status(204).send();
  });

  const taskSelection = {
    id: tasks.id,
    projectId: tasks.projectId,
    projectName: projects.name,
    title: tasks.title,
    instructions: tasks.instructions,
    priority: tasks.priority,
    status: tasks.status,
    attemptCount: tasks.attemptCount,
    statusReason: tasks.statusReason,
    createdAt: tasks.createdAt,
    updatedAt: tasks.updatedAt,
  };

  const priorityOrder = sql`CASE ${tasks.priority}
    WHEN 'urgent' THEN 0
    WHEN 'high' THEN 1
    WHEN 'normal' THEN 2
    ELSE 3 END`;

  app.get('/api/tasks', (request) => {
    const query = parseBody(taskListQuerySchema, request.query);
    const filters = [];
    if (query.projectId) filters.push(eq(tasks.projectId, query.projectId));
    if (query.status) filters.push(eq(tasks.status, query.status));

    return database.db
      .select(taskSelection)
      .from(tasks)
      .innerJoin(projects, eq(tasks.projectId, projects.id))
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(priorityOrder, asc(tasks.createdAt))
      .all();
  });

  app.get('/api/tasks/:id', (request) => {
    const { id } = request.params as { id: string };
    const task = database.db
      .select(taskSelection)
      .from(tasks)
      .innerJoin(projects, eq(tasks.projectId, projects.id))
      .where(eq(tasks.id, id))
      .get();
    if (!task) throw new HttpError(404, 'Task not found.');
    return task;
  });

  app.post('/api/tasks', (request, reply) => {
    const input = parseBody(taskInputSchema, request.body);
    const project = database.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .get();
    if (!project) throw new HttpError(400, 'The selected project does not exist.');

    const now = new Date().toISOString();
    const task = {
      ...input,
      id: randomUUID(),
      status: 'queued' as const,
      attemptCount: 0,
      statusReason: null,
      createdAt: now,
      updatedAt: now,
    };
    database.db.insert(tasks).values(task).run();
    return reply
      .status(201)
      .send(
        database.db
          .select(taskSelection)
          .from(tasks)
          .innerJoin(projects, eq(tasks.projectId, projects.id))
          .where(eq(tasks.id, task.id))
          .get(),
      );
  });

  app.patch('/api/tasks/:id', (request) => {
    const { id } = request.params as { id: string };
    const input = parseBody(taskPatchSchema, request.body);
    requireQueuedTask(database, id);
    database.db
      .update(tasks)
      .set({ ...input, updatedAt: new Date().toISOString() })
      .where(eq(tasks.id, id))
      .run();
    return getTask(database, id);
  });

  app.patch('/api/tasks/:id/priority', (request) => {
    const { id } = request.params as { id: string };
    const input = parseBody(taskPriorityPatchSchema, request.body);
    requireQueuedTask(database, id);
    database.db
      .update(tasks)
      .set({ priority: input.priority, updatedAt: new Date().toISOString() })
      .where(eq(tasks.id, id))
      .run();
    return getTask(database, id);
  });

  app.delete('/api/tasks/:id', (request, reply) => {
    const { id } = request.params as { id: string };
    requireQueuedTask(database, id);
    database.db
      .delete(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.status, 'queued')))
      .run();
    return reply.status(204).send();
  });

  app.post('/api/tasks/:id/requeue', (request) => {
    const { id } = request.params as { id: string };
    const task = database.db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!task) throw new HttpError(404, 'Task not found.');
    if (task.status !== 'failed' && task.status !== 'blocked') {
      throw new HttpError(409, 'Only failed or blocked tasks can be requeued.');
    }
    database.db
      .update(tasks)
      .set({ status: 'queued', statusReason: null, updatedAt: new Date().toISOString() })
      .where(eq(tasks.id, id))
      .run();
    return getTask(database, id);
  });

  app.get('/api/settings/worker', () => getWorkerSetting(database));

  app.patch('/api/settings/worker', (request) => {
    const { paused } = parseBody(workerSettingPatchSchema, request.body);
    const updatedAt = new Date().toISOString();
    database.db
      .insert(settings)
      .values({ key: workerPausedKey, value: String(paused), updatedAt })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: String(paused), updatedAt },
      })
      .run();
    return { paused, updatedAt };
  });

  const dashboardRoot = options.dashboardRoot ?? defaultDashboardRoot;
  if (dashboardRoot && existsSync(dashboardRoot)) {
    await app.register(fastifyStatic, {
      root: dashboardRoot,
      prefix: '/',
    });
  }

  return app;
}

type DatabaseHandle = ReturnType<typeof openDatabase>;

function requireQueuedTask(database: DatabaseHandle, id: string) {
  const task = database.db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!task) throw new HttpError(404, 'Task not found.');
  if (task.status !== 'queued') {
    throw new HttpError(409, 'Only queued tasks can be edited or deleted.');
  }
  return task;
}

function getTask(database: DatabaseHandle, id: string) {
  const task = database.db
    .select({
      id: tasks.id,
      projectId: tasks.projectId,
      projectName: projects.name,
      title: tasks.title,
      instructions: tasks.instructions,
      priority: tasks.priority,
      status: tasks.status,
      attemptCount: tasks.attemptCount,
      statusReason: tasks.statusReason,
      createdAt: tasks.createdAt,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(eq(tasks.id, id))
    .get();
  if (!task) throw new HttpError(404, 'Task not found.');
  return task;
}

function getWorkerSetting(database: DatabaseHandle) {
  const setting = database.db
    .select()
    .from(settings)
    .where(eq(settings.key, workerPausedKey))
    .get();
  return {
    paused: setting?.value === 'true',
    updatedAt: setting?.updatedAt ?? new Date(0).toISOString(),
  };
}

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';

describe('Phase 2 API', () => {
  let root: string;
  let databasePath: string;
  let repositoryPath: string;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'phantom-test-'));
    databasePath = path.join(root, 'data', 'phantom.db');
    repositoryPath = path.join(root, 'project');
    mkdirSync(repositoryPath);
    execFileSync('git', ['init', '-b', 'main'], { cwd: repositoryPath, stdio: 'ignore' });
    app = await createApp({ databasePath, dashboardRoot: false, schedulerEnabled: false });
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function createProject(overrides: Record<string, unknown> = {}) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: {
        name: 'Phantom test project',
        localPath: repositoryPath,
        remoteName: 'origin',
        remoteBranch: 'main',
        enabled: true,
        validationCommands: ['npm test'],
        ...overrides,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>();
  }

  async function createTask(projectId: string, title: string, priority = 'normal') {
    return app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { projectId, title, instructions: `Implement ${title}`, priority },
    });
  }

  it('serves health and version information', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'ok', database: 'connected' });

    const version = await app.inject({ method: 'GET', url: '/api/version' });
    expect(version.json()).toEqual({ name: 'phantom', version: '0.1.0', phase: 6 });

    const quota = await app.inject({ method: 'GET', url: '/api/quota' });
    expect(quota.json()).toMatchObject({ snapshot: null, fresh: false, error: null });

    const classifier = await app.inject({ method: 'GET', url: '/api/classifier/health' });
    expect(classifier.statusCode).toBe(200);
    expect(classifier.json()).toMatchObject({ available: true, model: 'deterministic-rules' });
  });

  it('serves the built dashboard from the production server', async () => {
    await app.close();
    const dashboardRoot = path.join(root, 'dashboard');
    mkdirSync(dashboardRoot);
    writeFileSync(path.join(dashboardRoot, 'index.html'), '<h1>Phantom dashboard</h1>');
    app = await createApp({ databasePath, dashboardRoot, schedulerEnabled: false });

    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('Phantom dashboard');
  });

  it('validates, creates, edits, toggles, lists, and deletes projects', async () => {
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Invalid', localPath: path.join(root, 'missing') },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ error: string }>().error).toContain('does not exist');

    const project = await createProject();
    const edited = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${project.id}`,
      payload: { name: 'Renamed project' },
    });
    expect(edited.json()).toMatchObject({
      name: 'Renamed project',
      validationCommands: ['npm test'],
    });

    const disabled = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${project.id}/enabled`,
      payload: { enabled: false },
    });
    expect(disabled.json()).toMatchObject({ enabled: false });

    const list = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(list.json<unknown[]>()).toHaveLength(1);

    const deleted = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}` });
    expect(deleted.statusCode).toBe(204);
  });

  it('creates safe queued tasks, orders them by priority, and supports queued mutations', async () => {
    const project = await createProject();
    const normal = await createTask(project.id, 'Normal task');
    const urgent = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        projectId: project.id,
        title: 'Urgent task',
        instructions: 'Fix it now',
        priority: 'urgent',
        status: 'running',
      },
    });
    expect(normal.statusCode).toBe(201);
    expect(urgent.statusCode).toBe(201);
    expect(urgent.json()).toMatchObject({ status: 'queued', attemptCount: 0 });

    const list = await app.inject({ method: 'GET', url: '/api/tasks' });
    expect(list.json<Array<{ title: string }>>().map((task) => task.title)).toEqual([
      'Urgent task',
      'Normal task',
    ]);

    const normalId = normal.json<{ id: string }>().id;
    const edited = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${normalId}`,
      payload: { title: 'Edited task', instructions: 'Updated instructions' },
    });
    expect(edited.json()).toMatchObject({ title: 'Edited task', status: 'queued' });

    const reprioritized = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${normalId}/priority`,
      payload: { priority: 'high' },
    });
    expect(reprioritized.json()).toMatchObject({ priority: 'high' });

    const deleted = await app.inject({ method: 'DELETE', url: `/api/tasks/${normalId}` });
    expect(deleted.statusCode).toBe(204);
  });

  it('only requeues failed or blocked tasks and never exposes a running transition', async () => {
    const project = await createProject();
    const response = await createTask(project.id, 'Blocked task');
    const taskId = response.json<{ id: string }>().id;

    const queuedAttempt = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/requeue` });
    expect(queuedAttempt.statusCode).toBe(409);

    const sqlite = new Database(databasePath);
    sqlite.prepare("UPDATE tasks SET status = 'blocked', status_reason = 'Manual fixture'").run();
    sqlite.close();

    const requeued = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/requeue` });
    expect(requeued.statusCode).toBe(200);
    expect(requeued.json()).toMatchObject({ status: 'queued', statusReason: null });

    const unsupported = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      payload: { status: 'running' },
    });
    expect(unsupported.statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` })).json()).toMatchObject(
      {
        status: 'queued',
      },
    );
  });

  it('persists projects, tasks, and the pause setting across a backend restart', async () => {
    const project = await createProject();
    await createTask(project.id, 'Persistent task', 'high');
    await app.inject({ method: 'PATCH', url: '/api/settings/worker', payload: { paused: true } });
    await app.close();

    app = await createApp({ databasePath, dashboardRoot: false, schedulerEnabled: false });
    expect(
      (await app.inject({ method: 'GET', url: '/api/projects' })).json<unknown[]>(),
    ).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/api/tasks' })).json<unknown[]>()).toHaveLength(
      1,
    );
    expect((await app.inject({ method: 'GET', url: '/api/settings/worker' })).json()).toMatchObject(
      { paused: true },
    );
  });

  it('returns helpful validation errors for invalid task input', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { projectId: 'not-an-id', title: '', instructions: '', priority: 'immediate' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ details: unknown[] }>().details.length).toBeGreaterThanOrEqual(3);
  });

  it('exposes worker health and durable task history', async () => {
    const project = await createProject();
    const response = await createTask(project.id, 'Audited task');
    const taskId = response.json<{ id: string }>().id;

    const health = await app.inject({ method: 'GET', url: '/api/worker/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'idle', paused: false });

    const history = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}/history` });
    expect(history.json()).toEqual([
      expect.objectContaining({
        previousStatus: null,
        newStatus: 'queued',
        reason: 'Task created.',
      }),
    ]);
    const runs = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}/executions` });
    expect(runs.json()).toEqual([]);
  });

  it('starts queued work after a backend restart and persists its result', async () => {
    const project = await createProject();
    const response = await createTask(project.id, 'Restart-ready task');
    const taskId = response.json<{ id: string }>().id;
    await app.close();

    app = await createApp({
      databasePath,
      dashboardRoot: false,
      schedulerConfig: { pollIntervalMs: 10, heartbeatIntervalMs: 5, staleAfterMs: 50 },
    });
    await expectTaskStatus(app, taskId, 'completed');
    await app.close();

    app = await createApp({ databasePath, dashboardRoot: false, schedulerEnabled: false });
    expect((await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` })).json()).toMatchObject(
      {
        status: 'completed',
        attemptCount: 1,
        classifierVersion: 'phase6-v1',
        classificationSource: 'deterministic',
        modelTier: 'economy',
        selectedModel: 'gpt-5.6-luna',
        selectedReasoning: 'medium',
        quotaEstimateSource: 'baseline',
      },
    );
    const executions = (
      await app.inject({ method: 'GET', url: `/api/tasks/${taskId}/executions` })
    ).json<Array<{ selectedModel: string; classifierVersion: string }>>();
    expect(executions[0]).toMatchObject({
      selectedModel: 'gpt-5.6-luna',
      classifierVersion: 'phase6-v1',
    });
    const history = (await app.inject({ method: 'GET', url: `/api/tasks/${taskId}/history` })).json<
      Array<{ newStatus: string }>
    >();
    expect(history.map((event) => event.newStatus)).toEqual([
      'queued',
      'classifying',
      'queued',
      'running',
      'completed',
    ]);
  });
});

async function expectTaskStatus(
  app: Awaited<ReturnType<typeof createApp>>,
  taskId: string,
  expected: string,
) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const task = (await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` })).json<{
      status: string;
    }>();
    if (task.status === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Task ${taskId} did not reach ${expected}.`);
}

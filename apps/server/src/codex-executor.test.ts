import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CodexEventKind } from '@phantom/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CodexExecutor, parseCodexEvent, redact } from './codex-executor.js';
import type { ExecutorContext } from './fake-executor.js';

const fixtures = fileURLToPath(new URL('./test-fixtures', import.meta.url));

describe('Codex JSONL event parser', () => {
  it('normalizes recorded progress, command, file, usage, and failure events', () => {
    const events = readFileSync(path.join(fixtures, 'codex-events.jsonl'), 'utf8')
      .trim()
      .split(/\r?\n/)
      .map(parseCodexEvent);
    expect(events.map((event) => event?.kind)).toEqual([
      'thread',
      'progress',
      'command',
      'file_change',
      'usage',
      'failure',
    ]);
    expect(events[0]?.threadId).toBe('0199-test-thread');
    expect(events[4]?.usage).toEqual({ inputTokens: 120, cachedInputTokens: 20, outputTokens: 45 });
    expect(events[5]?.rateLimited).toBe(true);
  });

  it('ignores non-JSON lines and redacts configured authentication values', () => {
    expect(parseCodexEvent('not-json')).toBeNull();
    expect(redact('token=very-secret-token', ['very-secret-token'])).toBe('token=[REDACTED]');
  });
});

describe('Codex executor integration', () => {
  let root: string;
  let previousScenario: string | undefined;
  let previousTestSecret: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'phantom-codex-'));
    previousScenario = process.env.PHANTOM_FAKE_CODEX_SCENARIO;
    previousTestSecret = process.env.PHANTOM_TEST_API_KEY;
  });

  afterEach(() => {
    if (previousScenario === undefined) delete process.env.PHANTOM_FAKE_CODEX_SCENARIO;
    else process.env.PHANTOM_FAKE_CODEX_SCENARIO = previousScenario;
    if (previousTestSecret === undefined) delete process.env.PHANTOM_TEST_API_KEY;
    else process.env.PHANTOM_TEST_API_KEY = previousTestSecret;
    rmSync(root, { recursive: true, force: true });
  });

  it('checks capabilities, persists a thread, and returns validated usage', async () => {
    process.env.PHANTOM_FAKE_CODEX_SCENARIO = 'success';
    const executor = createExecutor(2_000);
    await expect(executor.checkCapabilities()).resolves.toMatchObject({ authenticated: true });
    const observed = context();
    const result = await executor.execute(observed.value);
    expect(result).toMatchObject({
      status: 'completed',
      tokenUsage: { inputTokens: 100, cachedInputTokens: 5, outputTokens: 20 },
    });
    expect(observed.threadIds).toEqual(['0199-fixture-thread']);
    expect(observed.kinds).toContain('progress');
  });

  it('retries once in the original thread and aggregates per-turn usage', async () => {
    process.env.PHANTOM_FAKE_CODEX_SCENARIO = 'retry-success';
    const observed = context();
    const result = await createExecutor(2_000).execute(observed.value);
    expect(result).toMatchObject({
      status: 'completed',
      tokenUsage: { inputTokens: 30, cachedInputTokens: 5, outputTokens: 20 },
    });
    expect(observed.retries).toHaveLength(1);
    expect(observed.threadIds).toEqual(['0199-fixture-thread']);
  });

  it('resumes a persisted thread after worker recovery without creating a new retry', async () => {
    process.env.PHANTOM_FAKE_CODEX_SCENARIO = 'success';
    const observed = context();
    observed.value.task.codexThreadId = '0199-existing-thread';
    observed.value.task.recoveryCount = 1;
    const result = await createExecutor(2_000).execute(observed.value);
    expect(result).toMatchObject({
      status: 'completed',
      finalResult: { summary: 'Completed on the retry.' },
    });
    expect(observed.threadIds).toHaveLength(0);
    expect(observed.retries).toHaveLength(0);
  });

  it('classifies rate limits without attempting a normal retry', async () => {
    process.env.PHANTOM_FAKE_CODEX_SCENARIO = 'rate-limit';
    const observed = context();
    const result = await createExecutor(2_000).execute(observed.value);
    expect(result).toMatchObject({
      status: 'waiting_quota',
      finalResult: { failureCategory: 'rate_limit' },
    });
    expect(observed.retries).toHaveLength(0);
  });

  it('redacts known secrets from persisted events and raw logs', async () => {
    process.env.PHANTOM_FAKE_CODEX_SCENARIO = 'secret';
    process.env.PHANTOM_TEST_API_KEY = 'fixture-secret-value';
    const observed = context();
    const result = await createExecutor(2_000).execute(observed.value);
    expect(observed.messages.join(' ')).not.toContain('fixture-secret-value');
    expect(observed.messages.join(' ')).toContain('[REDACTED]');
    expect(readFileSync(result.rawLogPath!, 'utf8')).not.toContain('fixture-secret-value');
  });

  it('terminates timed-out and cancelled child processes distinctly', async () => {
    process.env.PHANTOM_FAKE_CODEX_SCENARIO = 'timeout';
    const timedOut = await createExecutor(30).execute(context().value);
    expect(timedOut).toMatchObject({
      status: 'failed',
      finalResult: { failureCategory: 'timeout' },
    });

    process.env.PHANTOM_FAKE_CODEX_SCENARIO = 'cancel';
    const abort = new AbortController();
    const cancelledContext = context(abort.signal);
    setTimeout(() => abort.abort(), 30);
    const cancelled = await createExecutor(2_000).execute(cancelledContext.value);
    expect(cancelled).toMatchObject({
      status: 'failed',
      finalResult: { failureCategory: 'cancelled' },
    });
  });

  function createExecutor(timeoutMs: number) {
    return new CodexExecutor({
      executable: process.execPath,
      executableArgs: [path.join(fixtures, 'fake-codex.cjs')],
      timeoutMs,
      logDirectory: path.join(root, 'logs'),
      model: 'fixture-model',
    });
  }

  function context(signal = new AbortController().signal) {
    const threadIds: string[] = [];
    const kinds: CodexEventKind[] = [];
    const retries: string[] = [];
    const messages: string[] = [];
    const value: ExecutorContext = {
      task: {
        id: 'task-1',
        title: 'Fixture task',
        instructions: 'Make a harmless change.',
        projectId: 'project-1',
        projectName: 'Fixture',
        projectPath: root,
        executionId: 'execution-1',
        attemptNumber: 1,
        recoveryCount: 0,
        codexThreadId: null,
        retryCount: 0,
      },
      signal,
      heartbeat: () => undefined,
      setThreadId: (threadId) => threadIds.push(threadId),
      reportEvent: (kind, message) => {
        kinds.push(kind);
        messages.push(message);
      },
      beginRetry: (reason) => retries.push(reason),
    };
    return { value, threadIds, kinds, retries, messages };
  }
});

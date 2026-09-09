import type { CodexEventKind, CodexFinalResult, TokenUsage } from '@phantom/shared';

export interface ExecutorTask {
  id: string;
  title: string;
  instructions: string;
  projectId: string;
  projectName: string;
  projectPath: string;
  remoteName: string;
  remoteBranch: string;
  executionId: string;
  attemptNumber: number;
  recoveryCount: number;
  codexThreadId: string | null;
  retryCount: number;
  startingHead: string | null;
  startingRemoteSha: string | null;
}

export interface ExecutorContext {
  task: ExecutorTask;
  signal: AbortSignal;
  heartbeat: () => void;
  setThreadId: (threadId: string) => void;
  reportEvent: (kind: CodexEventKind, message: string, metadata?: Record<string, unknown>) => void;
  beginRetry: (reason: string) => void;
  recordGitState: (state: {
    startingHead?: string;
    startingRemoteSha?: string;
    endingHead?: string;
    endingRemoteSha?: string;
    changedFiles?: Array<{ status: string; path: string }>;
    commitMetadata?: Record<string, string> | null;
  }) => void;
}

export type ExecutorResult =
  | {
      status: 'completed';
      reason?: string;
      finalResult?: CodexFinalResult;
      tokenUsage?: TokenUsage;
      rawLogPath?: string;
    }
  | {
      status: 'failed' | 'blocked' | 'waiting_quota';
      reason: string;
      finalResult?: CodexFinalResult;
      tokenUsage?: TokenUsage;
      rawLogPath?: string;
    };

export interface TaskExecutor {
  execute(context: ExecutorContext): Promise<ExecutorResult>;
}

export type FakeScenario =
  | { outcome: 'success'; delayMs?: number }
  | { outcome: 'failure'; delayMs?: number; reason?: string }
  | { outcome: 'crash'; delayMs?: number };

export class SimulatedCrashError extends Error {
  constructor() {
    super('The fake executor simulated a worker crash.');
  }
}

export class FakeExecutor implements TaskExecutor {
  constructor(
    private readonly resolveScenario: (task: ExecutorTask) => FakeScenario = scenarioFromTask,
  ) {}

  async execute(context: ExecutorContext): Promise<ExecutorResult> {
    const scenario = this.resolveScenario(context.task);
    await abortableDelay(scenario.delayMs ?? 10, context.signal);
    context.heartbeat();

    if (scenario.outcome === 'crash') throw new SimulatedCrashError();
    if (scenario.outcome === 'failure') {
      return { status: 'failed', reason: scenario.reason ?? 'Fake executor failure.' };
    }
    return { status: 'completed', reason: 'Fake executor completed successfully.' };
  }
}

function scenarioFromTask(task: ExecutorTask): FakeScenario {
  const delay = /\[fake:delay=(\d+)]/i.exec(task.instructions);
  const delayMs = delay ? Number(delay[1]) : 10;
  if (/\[fake:crash]/i.test(task.instructions) && task.recoveryCount === 0) {
    return { outcome: 'crash', delayMs };
  }
  if (/\[fake:failure]/i.test(task.instructions)) return { outcome: 'failure', delayMs };
  return { outcome: 'success', delayMs };
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, Math.max(0, delayMs));
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

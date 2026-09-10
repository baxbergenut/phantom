import { spawn } from 'node:child_process';
import { mkdir, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  codexFinalResultSchema,
  type CodexEventKind,
  type CodexFinalResult,
  type TokenUsage,
} from '@phantom/shared';

import type { ExecutorContext, ExecutorResult, TaskExecutor } from './fake-executor.js';
import { GitSafetyError, type GitStartState, type GitWorkflow } from './git-adapter.js';

const finalSchemaPath = fileURLToPath(
  new URL('../codex-final-result.schema.json', import.meta.url),
);

export interface CodexExecutorConfig {
  executable: string;
  executableArgs: string[];
  model: string;
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh';
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  timeoutMs: number;
  logDirectory: string;
  logRetentionDays: number;
  maxRawLogs: number;
}

export const defaultCodexExecutorConfig: CodexExecutorConfig = {
  executable: 'codex',
  executableArgs: [],
  model: 'gpt-5.6-sol',
  reasoningEffort: 'high',
  sandbox: 'danger-full-access',
  timeoutMs: 60 * 60 * 1_000,
  logDirectory: path.resolve('data', 'execution-logs'),
  logRetentionDays: 14,
  maxRawLogs: 100,
};

export interface ParsedCodexEvent {
  kind: CodexEventKind;
  message: string;
  metadata?: Record<string, unknown>;
  threadId?: string;
  usage?: TokenUsage;
  rateLimited?: boolean;
}

export class CodexCapabilityError extends Error {}

export class CodexExecutor implements TaskExecutor {
  readonly config: CodexExecutorConfig;

  constructor(
    config: Partial<CodexExecutorConfig> = {},
    private readonly gitAdapter?: GitWorkflow,
  ) {
    this.config = { ...defaultCodexExecutorConfig, ...config };
  }

  async checkCapabilities(): Promise<{ version: string; authenticated: boolean }> {
    const version = await capture(this.config.executable, [
      ...this.config.executableArgs,
      '--version',
    ]);
    const help = await capture(this.config.executable, [
      ...this.config.executableArgs,
      'exec',
      '--help',
    ]);
    for (const feature of ['--json', '--output-schema', '--output-last-message']) {
      if (!help.stdout.includes(feature)) {
        throw new CodexCapabilityError(`Installed Codex does not support ${feature}.`);
      }
    }
    const auth = await capture(
      this.config.executable,
      [...this.config.executableArgs, 'login', 'status'],
      true,
    );
    if (auth.code !== 0 || !/logged in|authenticated/i.test(`${auth.stdout}\n${auth.stderr}`)) {
      throw new CodexCapabilityError('Codex is not authenticated. Run `codex login`.');
    }
    return { version: version.stdout.trim(), authenticated: true };
  }

  async execute(context: ExecutorContext): Promise<ExecutorResult> {
    await mkdir(this.config.logDirectory, { recursive: true });
    await pruneLogs(this.config);
    const rawLogPath = path.join(this.config.logDirectory, `${context.task.executionId}.jsonl`);
    const lastMessagePath = path.join(
      this.config.logDirectory,
      `${context.task.executionId}-final.json`,
    );
    let threadId: string | null = context.task.codexThreadId;
    let usage = emptyUsage();
    let firstFailure = '';
    let gitStart: GitStartState | null = null;

    if (this.gitAdapter) {
      try {
        gitStart =
          context.task.recoveryCount > 0 &&
          context.task.startingHead &&
          context.task.startingRemoteSha
            ? {
                repositoryPath: context.task.projectPath,
                startingHead: context.task.startingHead,
                startingRemoteSha: context.task.startingRemoteSha,
              }
            : await this.gitAdapter.preflight(gitProject(context));
        context.recordGitState(gitStart);
        context.reportEvent('progress', 'Git preflight and fast-forward synchronization passed.', {
          startingHead: gitStart.startingHead,
          startingRemoteSha: gitStart.startingRemoteSha,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Git preflight failed.';
        return failureResult(
          'blocked',
          syntheticFailure('environment', reason),
          usage,
          rawLogPath,
          reason,
        );
      }
    }

    const resumedAfterRecovery = threadId
      ? {
          threadId,
          prompt: [
            context.task.resumeReason === 'quota_reset'
              ? 'The quota window reset after the original task was paused.'
              : 'The Phantom worker restarted while the original task was in progress.',
            'Resume the original task from the current repository state, verify the work, and return a valid result matching the supplied schema.',
            this.gitAdapter
              ? `Commit meaningful changes with an informative message and push normally to ${context.task.remoteName}/${context.task.remoteBranch}. Never force-push.`
              : 'Do not push changes; Phase 4 will add push authorization.',
          ].join('\n\n'),
        }
      : null;
    const first = await this.runTurn(
      context,
      resumedAfterRecovery,
      rawLogPath,
      lastMessagePath,
      (event) => {
        if (event.threadId && !threadId) {
          threadId = event.threadId;
          context.setThreadId(threadId);
        }
        if (event.usage) usage = addUsage(usage, event.usage);
      },
    );
    const firstResult = await readStructuredResult(lastMessagePath);
    if (first.rateLimited || firstResult?.failureCategory === 'rate_limit') {
      return failureResult(
        'waiting_quota',
        firstResult ?? syntheticFailure('rate_limit', first.error || 'Codex quota is unavailable.'),
        usage,
        rawLogPath,
        first.error,
      );
    }
    if (firstResult?.status === 'completed' && first.code === 0) {
      const verificationFailure = await this.verifyGit(context, gitStart, firstResult);
      if (!verificationFailure) return successResult(firstResult, usage, rawLogPath);
      firstFailure = verificationFailure;
    } else {
      firstFailure = describeFailure(first, firstResult);
    }
    if (context.signal.aborted || first.timedOut) {
      const category = first.timedOut ? 'timeout' : 'cancelled';
      return failureResult(
        'failed',
        syntheticFailure(category, firstFailure),
        usage,
        rawLogPath,
        firstFailure,
      );
    }
    if (!threadId || context.task.retryCount >= 1) {
      return failureResult(
        'failed',
        firstResult ?? syntheticFailure('malformed_output', firstFailure),
        usage,
        rawLogPath,
        firstFailure,
      );
    }

    context.beginRetry(firstFailure);
    const retryPrompt = [
      'The previous turn did not produce a successful Phantom result.',
      `Failure context: ${firstFailure}`,
      'Fix the issue if possible, finish the original task, and return a valid result matching the supplied schema.',
      ...(this.gitAdapter
        ? [
            `Commit meaningful changes with an informative message and push normally to ${context.task.remoteName}/${context.task.remoteBranch}. Never force-push.`,
          ]
        : ['Do not push changes; Phase 4 will add push authorization.']),
    ].join('\n\n');
    const second = await this.runTurn(
      context,
      { threadId, prompt: retryPrompt },
      rawLogPath,
      lastMessagePath,
      (event) => {
        if (event.usage) usage = addUsage(usage, event.usage);
      },
    );
    const secondResult = await readStructuredResult(lastMessagePath);
    if (second.rateLimited || secondResult?.failureCategory === 'rate_limit') {
      return failureResult(
        'waiting_quota',
        secondResult ??
          syntheticFailure('rate_limit', second.error || 'Codex quota is unavailable.'),
        usage,
        rawLogPath,
        second.error,
      );
    }
    if (secondResult?.status === 'completed' && second.code === 0) {
      const verificationFailure = await this.verifyGit(context, gitStart, secondResult);
      if (!verificationFailure) return successResult(secondResult, usage, rawLogPath);
      return failureResult(
        'failed',
        syntheticFailure('environment', verificationFailure),
        usage,
        rawLogPath,
        verificationFailure,
      );
    }
    const reason = describeFailure(second, secondResult);
    const result =
      secondResult ??
      syntheticFailure(
        context.signal.aborted ? 'cancelled' : second.timedOut ? 'timeout' : 'malformed_output',
        reason,
      );
    return failureResult('failed', result, usage, rawLogPath, reason);
  }

  private async verifyGit(
    context: ExecutorContext,
    start: GitStartState | null,
    result: CodexFinalResult,
  ): Promise<string | null> {
    if (!this.gitAdapter || !start) return null;
    try {
      const end = await this.gitAdapter.verifyCompletion(gitProject(context), start, result);
      context.recordGitState(end);
      context.reportEvent('progress', 'Git completion and remote reachability verified.', {
        endingHead: end.endingHead,
        endingRemoteSha: end.endingRemoteSha,
        changedFiles: end.changedFiles,
      });
      return null;
    } catch (error) {
      if (error instanceof GitSafetyError && error.state) {
        context.recordGitState(error.state);
      }
      return error instanceof Error ? error.message : 'Git completion verification failed.';
    }
  }

  private async runTurn(
    context: ExecutorContext,
    resume: { threadId: string; prompt: string } | null,
    rawLogPath: string,
    lastMessagePath: string,
    observe: (event: ParsedCodexEvent) => void,
  ): Promise<ProcessResult> {
    await rm(lastMessagePath, { force: true });
    const args = resume
      ? [
          'exec',
          'resume',
          '--json',
          '--output-schema',
          finalSchemaPath,
          '--output-last-message',
          lastMessagePath,
          '--model',
          this.config.model,
          '-c',
          `model_reasoning_effort="${this.config.reasoningEffort}"`,
          '-c',
          'approval_policy="never"',
          '-c',
          `sandbox_mode="${this.config.sandbox}"`,
          resume.threadId,
          '-',
        ]
      : [
          'exec',
          '--json',
          '--output-schema',
          finalSchemaPath,
          '--output-last-message',
          lastMessagePath,
          '--model',
          this.config.model,
          '--sandbox',
          this.config.sandbox,
          '-c',
          `model_reasoning_effort="${this.config.reasoningEffort}"`,
          '-c',
          'approval_policy="never"',
          '--cd',
          context.task.projectPath,
          '-',
        ];
    const prompt = resume?.prompt ?? taskPrompt(context, Boolean(this.gitAdapter));
    const secrets = knownSecrets();
    const log = await open(rawLogPath, 'a');
    let logWrites = Promise.resolve();
    let buffer = '';
    let stderr = '';
    let rateLimited = false;
    let timedOut = false;
    const child = spawn(this.config.executable, [...this.config.executableArgs, ...args], {
      cwd: context.task.projectPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env,
    });
    const terminate = () => child.kill();
    context.signal.addEventListener('abort', terminate, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, this.config.timeoutMs);
    timeout.unref();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        logWrites = logWrites.then(() => log.appendFile(`${redact(line, secrets)}\n`));
        const parsed = parseCodexEvent(line);
        if (!parsed) continue;
        const event = redactEvent(parsed, secrets);
        rateLimited ||= Boolean(event.rateLimited);
        observe(event);
        context.reportEvent(event.kind, event.message, event.metadata);
        context.heartbeat();
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 16_000) stderr = stderr.slice(-16_000);
    });
    child.stdin.end(prompt);
    const processResult = await new Promise<{ code: number; error?: string }>((resolve) => {
      child.once('error', (error) => resolve({ code: -1, error: error.message }));
      child.once('close', (code) => resolve({ code: code ?? -1 }));
    });
    clearTimeout(timeout);
    context.signal.removeEventListener('abort', terminate);
    if (buffer.trim()) {
      logWrites = logWrites.then(() => log.appendFile(`${redact(buffer, secrets)}\n`));
      const parsed = parseCodexEvent(buffer);
      if (parsed) {
        const event = redactEvent(parsed, secrets);
        rateLimited ||= Boolean(event.rateLimited);
        observe(event);
        context.reportEvent(event.kind, event.message, event.metadata);
      }
    }
    const redactedError = redact(processResult.error ?? stderr.trim(), secrets);
    if (redactedError) {
      logWrites = logWrites.then(() =>
        log.appendFile(`${JSON.stringify({ stderr: redactedError })}\n`),
      );
    }
    await logWrites;
    await log.close();
    return {
      code: processResult.code,
      error: redactedError,
      rateLimited: rateLimited || /rate.?limit|quota|too many requests|429/i.test(redactedError),
      timedOut,
    };
  }
}

interface ProcessResult {
  code: number;
  error: string;
  rateLimited: boolean;
  timedOut: boolean;
}

export function parseCodexEvent(line: string): ParsedCodexEvent | null {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = stringValue(event.type) ?? 'progress';
  if (type === 'thread.started') {
    const threadId = stringValue(event.thread_id) ?? stringValue(event.threadId);
    return { kind: 'thread', message: 'Codex thread started.', ...(threadId ? { threadId } : {}) };
  }
  if (type === 'turn.completed') {
    const usage = parseUsage(event.usage);
    return {
      kind: 'usage',
      message: 'Codex turn completed.',
      ...(usage ? { usage, metadata: usage as unknown as Record<string, unknown> } : {}),
    };
  }
  if (type === 'turn.failed' || type === 'error') {
    const message = extractMessage(event) || 'Codex reported an execution failure.';
    return {
      kind: 'failure',
      message,
      rateLimited: /rate.?limit|quota|too many requests|429/i.test(message),
    };
  }
  const item = objectValue(event.item);
  const itemType = stringValue(item?.type);
  const message = extractMessage(item ?? event) || friendlyType(type);
  if (itemType === 'command_execution') {
    return { kind: 'command', message: truncate(message), metadata: safeMetadata(item ?? event) };
  }
  if (itemType === 'file_change') {
    return {
      kind: 'file_change',
      message: truncate(message),
      metadata: safeMetadata(item ?? event),
    };
  }
  if (itemType === 'agent_message') {
    return { kind: 'progress', message: truncate(message) };
  }
  return { kind: 'progress', message: truncate(message) };
}

function taskPrompt(context: ExecutorContext, pushesEnabled: boolean): string {
  return [
    `Task: ${context.task.title}`,
    context.task.instructions,
    'Work only in the configured project directory. Implement and verify the task autonomously.',
    pushesEnabled
      ? `Work directly on ${context.task.remoteBranch}. Commit meaningful changes with an informative task-related message, then push normally to ${context.task.remoteName}/${context.task.remoteBranch}. Never force-push. If no changes are required, do not create an empty commit and explain why in summary.`
      : 'Do not push changes; Phase 4 will add push authorization.',
    'Your final response must match the supplied JSON Schema exactly.',
  ].join('\n\n');
}

async function readStructuredResult(filePath: string): Promise<CodexFinalResult | null> {
  try {
    const parsed = JSON.parse(redact(await readFile(filePath, 'utf8'))) as unknown;
    const result = codexFinalResultSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function describeFailure(process: ProcessResult, result: CodexFinalResult | null): string {
  if (process.timedOut) return 'Codex execution timed out.';
  if (result?.failureReason) return result.failureReason;
  if (process.error) return process.error;
  if (!result) return 'Codex did not return a valid structured final result.';
  return `Codex exited with code ${process.code}.`;
}

function successResult(
  finalResult: CodexFinalResult,
  tokenUsage: TokenUsage,
  rawLogPath: string,
): ExecutorResult {
  return { status: 'completed', reason: finalResult.summary, finalResult, tokenUsage, rawLogPath };
}

function failureResult(
  status: 'failed' | 'blocked' | 'waiting_quota',
  finalResult: CodexFinalResult | null,
  tokenUsage: TokenUsage,
  rawLogPath: string,
  fallback: string,
): ExecutorResult {
  const result = finalResult ?? syntheticFailure('malformed_output', fallback || 'Invalid output.');
  return {
    status,
    reason: result.failureReason ?? result.summary,
    finalResult: result,
    tokenUsage,
    rawLogPath,
  };
}

function syntheticFailure(
  category: CodexFinalResult['failureCategory'],
  reason: string,
): CodexFinalResult {
  return {
    schemaVersion: 1,
    status: 'failed',
    summary: reason || 'Codex execution failed.',
    completedItems: [],
    incompleteItems: ['The requested task was not completed.'],
    failureCategory: category,
    failureReason: reason || 'Codex execution failed.',
    retryRecommended: category !== 'cancelled',
    commitSha: null,
    pushed: false,
  };
}

function parseUsage(value: unknown): TokenUsage | undefined {
  const usage = objectValue(value);
  if (!usage) return undefined;
  return {
    inputTokens: numberValue(usage.input_tokens ?? usage.inputTokens),
    cachedInputTokens: numberValue(usage.cached_input_tokens ?? usage.cachedInputTokens),
    outputTokens: numberValue(usage.output_tokens ?? usage.outputTokens),
  };
}

function emptyUsage(): TokenUsage {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  };
}

function extractMessage(value: Record<string, unknown>): string {
  const nestedError = objectValue(value.error);
  return (
    stringValue(value.text) ??
    stringValue(value.message) ??
    stringValue(value.command) ??
    stringValue(value.error) ??
    stringValue(nestedError?.message) ??
    ''
  );
}

function safeMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const allowed = ['status', 'exit_code', 'aggregated_output', 'command', 'changes'];
  return Object.fromEntries(
    allowed
      .filter((key) => value[key] !== undefined)
      .map((key) => [
        key,
        typeof value[key] === 'string' ? truncate(value[key] as string, 2_000) : value[key],
      ]),
  );
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function friendlyType(type: string): string {
  return type.replaceAll('.', ' ').replaceAll('_', ' ');
}

function truncate(value: string, maximum = 4_000): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function knownSecrets(): string[] {
  return Object.entries(process.env)
    .filter(([key, value]) => value && /(TOKEN|SECRET|PASSWORD|API_KEY|AUTH)/i.test(key))
    .map(([, value]) => value as string)
    .filter((value) => value.length >= 8);
}

export function redact(value: string, secrets = knownSecrets()): string {
  let result = value;
  for (const secret of secrets) result = result.split(secret).join('[REDACTED]');
  return result;
}

function redactEvent(event: ParsedCodexEvent, secrets: string[]): ParsedCodexEvent {
  return {
    ...event,
    message: redact(event.message, secrets),
    ...(event.metadata
      ? {
          metadata: JSON.parse(redact(JSON.stringify(event.metadata), secrets)) as Record<
            string,
            unknown
          >,
        }
      : {}),
  };
}

async function capture(executable: string, args: string[], allowFailure = false) {
  return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.once('error', (error) => reject(new CodexCapabilityError(error.message)));
    child.once('close', (code) => {
      const result = { code: code ?? -1, stdout, stderr };
      if (!allowFailure && result.code !== 0) {
        reject(new CodexCapabilityError(stderr.trim() || `Codex exited with ${result.code}.`));
      } else resolve(result);
    });
  });
}

async function pruneLogs(config: CodexExecutorConfig): Promise<void> {
  const entries = await readdir(config.logDirectory).catch(() => [] as string[]);
  const files = await Promise.all(
    entries
      .filter((name) => name.endsWith('.jsonl') || name.endsWith('-final.json'))
      .map(async (name) => {
        const filePath = path.join(config.logDirectory, name);
        return { filePath, modified: (await stat(filePath)).mtimeMs };
      }),
  );
  const cutoff = Date.now() - config.logRetentionDays * 24 * 60 * 60 * 1_000;
  const newestFirst = files.sort((left, right) => right.modified - left.modified);
  await Promise.all(
    newestFirst
      .filter((file, index) => file.modified < cutoff || index >= config.maxRawLogs * 2)
      .map((file) => rm(file.filePath, { force: true })),
  );
}

export function codexExecutorConfigFromEnvironment(
  logDirectory?: string,
): Partial<CodexExecutorConfig> {
  return {
    ...(process.env.PHANTOM_CODEX_EXECUTABLE
      ? { executable: process.env.PHANTOM_CODEX_EXECUTABLE }
      : {}),
    ...(process.env.PHANTOM_CODEX_MODEL ? { model: process.env.PHANTOM_CODEX_MODEL } : {}),
    ...(process.env.PHANTOM_CODEX_REASONING === 'low' ||
    process.env.PHANTOM_CODEX_REASONING === 'medium' ||
    process.env.PHANTOM_CODEX_REASONING === 'high' ||
    process.env.PHANTOM_CODEX_REASONING === 'xhigh'
      ? { reasoningEffort: process.env.PHANTOM_CODEX_REASONING }
      : {}),
    ...(positiveInteger(process.env.PHANTOM_CODEX_TIMEOUT_MS)
      ? { timeoutMs: positiveInteger(process.env.PHANTOM_CODEX_TIMEOUT_MS)! }
      : {}),
    ...(logDirectory ? { logDirectory } : {}),
  };
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function gitProject(context: ExecutorContext) {
  return {
    localPath: context.task.projectPath,
    remoteName: context.task.remoteName,
    remoteBranch: context.task.remoteBranch,
  };
}

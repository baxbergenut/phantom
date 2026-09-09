import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { CodexEventKind, TaskPriority, WorkerHealth } from '@phantom/shared';

import type { PhantomDatabase } from './db/index.js';
import {
  FakeExecutor,
  SimulatedCrashError,
  type ExecutorTask,
  type TaskExecutor,
} from './fake-executor.js';
import { transitionTaskInTransaction } from './task-state.js';

const workerPausedKey = 'worker.paused';
const leaseKey = 'global';

export interface SchedulerConfig {
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  staleAfterMs: number;
  leaseDurationMs: number;
}

export const defaultSchedulerConfig: SchedulerConfig = {
  pollIntervalMs: 60_000,
  heartbeatIntervalMs: 5_000,
  staleAfterMs: 30_000,
  leaseDurationMs: 15_000,
};

interface SchedulerLogger {
  info(data: Record<string, unknown>, message: string): void;
  warn(data: Record<string, unknown>, message: string): void;
  error(data: Record<string, unknown>, message: string): void;
}

const silentLogger: SchedulerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface WorkRow extends ExecutorTask {
  correlationId: string;
}

interface QueuedTaskRow {
  id: string;
  title: string;
  instructions: string;
  projectId: string;
  projectName: string;
  projectPath: string;
  remoteName: string;
  remoteBranch: string;
  priority: TaskPriority;
  attemptCount: number;
}

interface RecoveringRow extends QueuedTaskRow {
  executionId: string;
  attemptNumber: number;
  recoveryCount: number;
  recoveryMetadata: string | null;
  codexThreadId: string | null;
  retryCount: number;
  startingHead: string | null;
  startingRemoteSha: string | null;
}

interface ActiveExecutionRow {
  executionId: string;
  heartbeatAt: string;
}

interface LeaseRow {
  workerId: string | null;
  executionId: string | null;
  leaseExpiresAt: string | null;
}

export class Scheduler {
  readonly workerId: string;
  readonly config: SchedulerConfig;

  private timer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private tickInFlight = false;
  private stopping = false;
  private activeWork: WorkRow | null = null;
  private activePromise: Promise<void> | null = null;
  private abortController: AbortController | null = null;

  constructor(
    private readonly database: PhantomDatabase,
    options: {
      workerId?: string;
      executor?: TaskExecutor;
      config?: Partial<SchedulerConfig>;
      logger?: SchedulerLogger;
      now?: () => Date;
    } = {},
  ) {
    this.workerId = options.workerId ?? `worker-${randomUUID()}`;
    this.config = { ...defaultSchedulerConfig, ...options.config };
    this.executor = options.executor ?? new FakeExecutor();
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? (() => new Date());
  }

  private readonly executor: TaskExecutor;
  private readonly logger: SchedulerLogger;
  private readonly now: () => Date;

  start(): void {
    if (this.timer || this.stopping) return;
    this.resetShutdownMarker();
    this.recoverStaleExecutions();
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.pollIntervalMs);
    this.timer.unref();
  }

  async tick(): Promise<boolean> {
    if (this.stopping || this.tickInFlight) return false;
    this.tickInFlight = true;
    try {
      this.recoverStaleExecutions();
      const work = this.acquireWork();
      if (!work) return false;
      this.activeWork = work;
      this.abortController = new AbortController();
      this.activePromise = this.runExecution(work, this.abortController.signal);
      await this.activePromise;
      return true;
    } finally {
      this.activePromise = null;
      this.activeWork = null;
      this.abortController = null;
      this.tickInFlight = false;
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.activePromise ?? Promise.resolve();
    if (!this.timer && !this.activeWork && !this.tickInFlight) return;
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;

    if (this.activeWork) {
      const now = this.now().toISOString();
      this.database.sqlite
        .transaction(() => {
          const metadata = JSON.stringify({
            reason: 'graceful_shutdown',
            interruptedAt: now,
            previousWorkerId: this.workerId,
          });
          this.database.sqlite
            .prepare(
              `UPDATE executions
               SET state = 'recovering', worker_id = NULL, heartbeat_at = ?,
                   recovery_metadata = ?, updated_at = ?
               WHERE id = ? AND state = 'running' AND worker_id = ?`,
            )
            .run(now, metadata, now, this.activeWork!.executionId, this.workerId);
          this.releaseLease(now, true);
        })
        .immediate();
      this.abortController?.abort(new DOMException('Scheduler is stopping.', 'AbortError'));
      this.logger.info(this.logContext(this.activeWork), 'Active execution saved for recovery.');
    } else {
      const now = this.now().toISOString();
      this.database.sqlite.transaction(() => this.releaseLease(now, true)).immediate();
    }

    await this.activePromise;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  cancelActiveTask(reason = 'Cancelled by the operator.'): boolean {
    if (!this.activeWork || !this.abortController || this.abortController.signal.aborted) {
      return false;
    }
    this.reportExecutionEvent(this.activeWork, 'failure', reason, { category: 'cancelled' });
    this.abortController.abort(new DOMException(reason, 'AbortError'));
    return true;
  }

  getHealth(): WorkerHealth {
    const sqlite = this.database.sqlite;
    const paused =
      (
        sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(workerPausedKey) as
          { value: string } | undefined
      )?.value === 'true';
    const lease = sqlite
      .prepare(
        `SELECT worker_id AS workerId, execution_id AS executionId,
                lease_expires_at AS leaseExpiresAt, heartbeat_at AS heartbeatAt,
                last_poll_at AS lastPollAt, shutting_down AS shuttingDown
         FROM worker_lease WHERE key = ?`,
      )
      .get(leaseKey) as
      | (LeaseRow & { heartbeatAt: string | null; lastPollAt: string | null; shuttingDown: number })
      | undefined;
    const current = sqlite
      .prepare(
        `SELECT t.id, t.title, p.name AS projectName, t.priority,
                e.heartbeat_at AS heartbeatAt, e.state
         FROM executions e
         JOIN tasks t ON t.id = e.task_id
         JOIN projects p ON p.id = t.project_id
         WHERE e.state IN ('running', 'recovering')
         ORDER BY e.created_at LIMIT 1`,
      )
      .get() as
      | {
          id: string;
          title: string;
          projectName: string;
          priority: TaskPriority;
          heartbeatAt: string;
          state: 'running' | 'recovering';
        }
      | undefined;
    const next = this.selectNextQueuedTask();
    const stale =
      current && this.now().getTime() - Date.parse(current.heartbeatAt) >= this.config.staleAfterMs;
    let status: WorkerHealth['status'] = 'idle';
    if (this.stopping || lease?.shuttingDown) status = 'stopping';
    else if (paused) status = 'paused';
    else if (stale || current?.state === 'recovering') status = 'stale';
    else if (current) status = 'running';

    return {
      status,
      workerId: this.workerId,
      leaseOwner: lease?.workerId ?? null,
      leaseExpiresAt: lease?.leaseExpiresAt ?? null,
      lastPollAt: lease?.lastPollAt ?? null,
      heartbeatAt: current?.heartbeatAt ?? lease?.heartbeatAt ?? null,
      currentTask: current
        ? {
            id: current.id,
            title: current.title,
            projectName: current.projectName,
            priority: current.priority,
          }
        : null,
      nextEligibleTask: next
        ? {
            id: next.id,
            title: next.title,
            projectName: next.projectName,
            priority: next.priority,
          }
        : null,
      paused,
      pollIntervalMs: this.config.pollIntervalMs,
      staleAfterMs: this.config.staleAfterMs,
    };
  }

  recoverStaleExecutions(): number {
    const now = this.now();
    const nowIso = now.toISOString();
    const staleBefore = new Date(now.getTime() - this.config.staleAfterMs).toISOString();
    return this.database.sqlite
      .transaction(() => {
        const stale = this.database.sqlite
          .prepare(
            `SELECT id, task_id AS taskId, worker_id AS workerId FROM executions
             WHERE state = 'running' AND heartbeat_at <= ?`,
          )
          .all(staleBefore) as Array<{ id: string; taskId: string; workerId: string | null }>;
        for (const execution of stale) {
          const metadata = JSON.stringify({
            reason: 'stale_heartbeat',
            detectedAt: nowIso,
            previousWorkerId: execution.workerId,
          });
          this.database.sqlite
            .prepare(
              `UPDATE executions SET state = 'recovering', worker_id = NULL,
                 recovery_metadata = ?, updated_at = ? WHERE id = ? AND state = 'running'`,
            )
            .run(metadata, nowIso, execution.id);
          this.database.sqlite
            .prepare(
              `UPDATE worker_lease SET worker_id = NULL, execution_id = NULL,
                 lease_expires_at = NULL, updated_at = ? WHERE key = ? AND execution_id = ?`,
            )
            .run(nowIso, leaseKey, execution.id);
          this.logger.warn(
            {
              component: 'scheduler',
              taskId: execution.taskId,
              executionId: execution.id,
              correlationId: execution.id,
              previousWorkerId: execution.workerId,
            },
            'Stale execution marked for recovery.',
          );
        }
        return stale.length;
      })
      .immediate();
  }

  private acquireWork(): WorkRow | null {
    const now = this.now();
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + this.config.leaseDurationMs).toISOString();
    return this.database.sqlite
      .transaction(() => {
        const sqlite = this.database.sqlite;
        sqlite
          .prepare(`UPDATE worker_lease SET last_poll_at = ?, updated_at = ? WHERE key = ?`)
          .run(nowIso, nowIso, leaseKey);
        const paused = (
          sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(workerPausedKey) as
            { value: string } | undefined
        )?.value;
        if (paused === 'true') return null;

        const lease = sqlite
          .prepare(
            `SELECT worker_id AS workerId, execution_id AS executionId,
                    lease_expires_at AS leaseExpiresAt
             FROM worker_lease WHERE key = ?`,
          )
          .get(leaseKey) as LeaseRow;
        if (lease.workerId && lease.leaseExpiresAt && lease.leaseExpiresAt > nowIso) return null;

        const freshBefore = new Date(now.getTime() - this.config.staleAfterMs).toISOString();
        const active = sqlite
          .prepare(
            `SELECT id AS executionId, heartbeat_at AS heartbeatAt FROM executions
             WHERE state = 'running' AND heartbeat_at > ? LIMIT 1`,
          )
          .get(freshBefore) as ActiveExecutionRow | undefined;
        if (active) return null;

        const recovering = sqlite
          .prepare(
            `SELECT e.id AS executionId, e.attempt_number AS attemptNumber,
                    e.recovery_count AS recoveryCount, e.recovery_metadata AS recoveryMetadata,
                    e.codex_thread_id AS codexThreadId, e.retry_count AS retryCount,
                    e.starting_head AS startingHead,
                    e.starting_remote_sha AS startingRemoteSha,
                    t.id, t.title, t.instructions, t.project_id AS projectId,
                    p.name AS projectName, p.local_path AS projectPath,
                    p.remote_name AS remoteName, p.remote_branch AS remoteBranch,
                    t.priority, t.attempt_count AS attemptCount
             FROM executions e
             JOIN tasks t ON t.id = e.task_id
             JOIN projects p ON p.id = t.project_id
             WHERE e.state = 'recovering'
             ORDER BY e.created_at LIMIT 1`,
          )
          .get() as RecoveringRow | undefined;
        if (recovering) {
          const correlationId = recovering.executionId;
          const previous = parseRecoveryMetadata(recovering.recoveryMetadata);
          const metadata = JSON.stringify({
            ...previous,
            resumedAt: nowIso,
            resumeWorkerId: this.workerId,
          });
          sqlite
            .prepare(
              `UPDATE executions SET state = 'running', worker_id = ?, heartbeat_at = ?,
                 recovery_count = recovery_count + 1, recovery_metadata = ?, updated_at = ?
               WHERE id = ? AND state = 'recovering'`,
            )
            .run(this.workerId, nowIso, metadata, nowIso, recovering.executionId);
          this.claimLease(recovering.executionId, nowIso, leaseExpiresAt);
          this.logger.info(
            this.logContext({
              ...recovering,
              correlationId,
            }),
            'Recovered execution acquired.',
          );
          return {
            ...recovering,
            correlationId,
            recoveryCount: recovering.recoveryCount + 1,
          };
        }

        const task = this.selectNextQueuedTask();
        if (!task) {
          sqlite
            .prepare(
              `UPDATE worker_lease SET worker_id = NULL, execution_id = NULL,
                 lease_expires_at = NULL, updated_at = ? WHERE key = ?`,
            )
            .run(nowIso, leaseKey);
          return null;
        }

        const executionId = randomUUID();
        const attemptNumber = task.attemptCount + 1;
        sqlite
          .prepare(
            `INSERT INTO executions
              (id, task_id, attempt_number, state, worker_id, started_at, heartbeat_at,
               recovery_count, created_at, updated_at)
             VALUES (?, ?, ?, 'running', ?, ?, ?, 0, ?, ?)`,
          )
          .run(executionId, task.id, attemptNumber, this.workerId, nowIso, nowIso, nowIso, nowIso);
        sqlite
          .prepare('UPDATE tasks SET attempt_count = ? WHERE id = ?')
          .run(attemptNumber, task.id);
        transitionTaskInTransaction(sqlite, {
          taskId: task.id,
          newStatus: 'running',
          expectedStatus: 'queued',
          reason: 'Acquired by the Codex executor.',
          executionId,
          correlationId: executionId,
          now: nowIso,
        });
        this.claimLease(executionId, nowIso, leaseExpiresAt);
        const work = {
          ...task,
          executionId,
          attemptNumber,
          recoveryCount: 0,
          codexThreadId: null,
          retryCount: 0,
          startingHead: null,
          startingRemoteSha: null,
          correlationId: executionId,
        };
        this.logger.info(this.logContext(work), 'Queued task acquired.');
        return work;
      })
      .immediate();
  }

  private async runExecution(work: WorkRow, signal: AbortSignal): Promise<void> {
    this.startHeartbeat(work);
    try {
      const result = await this.executor.execute({
        task: work,
        signal,
        heartbeat: () => this.heartbeat(work),
        setThreadId: (threadId) => this.setThreadId(work, threadId),
        reportEvent: (kind, message, metadata) =>
          this.reportExecutionEvent(work, kind, message, metadata),
        beginRetry: (reason) => this.beginRetry(work, reason),
        recordGitState: (state) => this.recordGitState(work, state),
      });
      if (this.stopping) return;
      this.reportExecutionEvent(
        work,
        'final',
        result.reason ??
          (result.status === 'completed' ? 'Execution completed.' : 'Execution failed.'),
        result.finalResult as unknown as Record<string, unknown> | undefined,
      );
      this.finishExecution(work, result.status, result.reason, {
        finalResult: result.finalResult,
        tokenUsage: result.tokenUsage,
        rawLogPath: result.rawLogPath,
      });
    } catch (error) {
      if (this.stopping && signal.aborted) return;
      if (error instanceof SimulatedCrashError) {
        this.logger.error(this.logContext(work), error.message);
        return;
      }
      const reason = error instanceof Error ? error.message : 'Unknown executor error.';
      this.finishExecution(work, 'failed', reason);
    } finally {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private finishExecution(
    work: WorkRow,
    result: 'completed' | 'failed' | 'blocked' | 'waiting_quota',
    reason = result === 'completed' ? 'Codex completed successfully.' : 'Execution failed.',
    details?: {
      finalResult?: unknown | undefined;
      tokenUsage?: unknown | undefined;
      rawLogPath?: string | undefined;
    },
  ): void {
    const now = this.now().toISOString();
    this.database.sqlite
      .transaction(() => {
        const owned = this.database.sqlite
          .prepare("SELECT id FROM executions WHERE id = ? AND state = 'running' AND worker_id = ?")
          .get(work.executionId, this.workerId);
        if (!owned) return;
        transitionTaskInTransaction(this.database.sqlite, {
          taskId: work.id,
          newStatus: result,
          expectedStatus: 'running',
          reason,
          statusReason: result === 'completed' ? null : reason,
          executionId: work.executionId,
          correlationId: work.correlationId,
          now,
        });
        this.database.sqlite
          .prepare(
            `UPDATE executions SET state = ?, finished_at = ?, heartbeat_at = ?,
               error = ?, final_result = COALESCE(?, final_result),
               token_usage = COALESCE(?, token_usage), raw_log_path = COALESCE(?, raw_log_path),
               updated_at = ? WHERE id = ?`,
          )
          .run(
            result === 'completed' ? 'completed' : 'failed',
            now,
            now,
            result === 'completed' ? null : reason,
            details?.finalResult ? JSON.stringify(details.finalResult) : null,
            details?.tokenUsage ? JSON.stringify(details.tokenUsage) : null,
            details?.rawLogPath ?? null,
            now,
            work.executionId,
          );
        this.releaseLease(now, false);
      })
      .immediate();
    this.logger.info({ ...this.logContext(work), result, reason }, 'Execution finished.');
  }

  private startHeartbeat(work: WorkRow): void {
    this.heartbeatTimer = setInterval(() => this.heartbeat(work), this.config.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  private heartbeat(work: WorkRow): void {
    if (this.stopping) return;
    const now = this.now();
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + this.config.leaseDurationMs).toISOString();
    this.database.sqlite
      .transaction(() => {
        this.database.sqlite
          .prepare(
            `UPDATE executions SET heartbeat_at = ?, updated_at = ?
             WHERE id = ? AND state = 'running' AND worker_id = ?`,
          )
          .run(nowIso, nowIso, work.executionId, this.workerId);
        this.database.sqlite
          .prepare(
            `UPDATE worker_lease SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
             WHERE key = ? AND execution_id = ? AND worker_id = ?`,
          )
          .run(nowIso, leaseExpiresAt, nowIso, leaseKey, work.executionId, this.workerId);
      })
      .immediate();
  }

  private selectNextQueuedTask(): QueuedTaskRow | undefined {
    return this.database.sqlite
      .prepare(
        `SELECT t.id, t.title, t.instructions, t.project_id AS projectId,
                p.name AS projectName, p.local_path AS projectPath,
                p.remote_name AS remoteName, p.remote_branch AS remoteBranch,
                t.priority, t.attempt_count AS attemptCount
         FROM tasks t JOIN projects p ON p.id = t.project_id
         WHERE t.status = 'queued' AND p.enabled = true
         ORDER BY CASE t.priority
           WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
           t.created_at, t.id
         LIMIT 1`,
      )
      .get() as QueuedTaskRow | undefined;
  }

  private claimLease(executionId: string, heartbeatAt: string, leaseExpiresAt: string): void {
    this.database.sqlite
      .prepare(
        `UPDATE worker_lease SET worker_id = ?, execution_id = ?, lease_expires_at = ?,
           heartbeat_at = ?, shutting_down = false, updated_at = ? WHERE key = ?`,
      )
      .run(this.workerId, executionId, leaseExpiresAt, heartbeatAt, heartbeatAt, leaseKey);
  }

  private releaseLease(now: string, shuttingDown: boolean): void {
    this.database.sqlite
      .prepare(
        `UPDATE worker_lease SET worker_id = NULL, execution_id = NULL,
           lease_expires_at = NULL, heartbeat_at = ?, shutting_down = ?, updated_at = ?
         WHERE key = ? AND (worker_id = ? OR worker_id IS NULL)`,
      )
      .run(now, shuttingDown ? 1 : 0, now, leaseKey, this.workerId);
  }

  private setThreadId(work: WorkRow, threadId: string): void {
    this.database.sqlite
      .prepare(
        `UPDATE executions SET codex_thread_id = COALESCE(codex_thread_id, ?), updated_at = ?
         WHERE id = ? AND state = 'running' AND worker_id = ?`,
      )
      .run(threadId, this.now().toISOString(), work.executionId, this.workerId);
  }

  private recordGitState(
    work: WorkRow,
    state: {
      startingHead?: string;
      startingRemoteSha?: string;
      endingHead?: string;
      endingRemoteSha?: string;
      changedFiles?: Array<{ status: string; path: string }>;
      commitMetadata?: Record<string, string> | null;
    },
  ): void {
    this.database.sqlite
      .prepare(
        `UPDATE executions SET
           starting_head = COALESCE(?, starting_head),
           starting_remote_sha = COALESCE(?, starting_remote_sha),
           ending_head = COALESCE(?, ending_head),
           ending_remote_sha = COALESCE(?, ending_remote_sha),
           changed_files = COALESCE(?, changed_files),
           commit_metadata = COALESCE(?, commit_metadata), updated_at = ?
         WHERE id = ? AND state = 'running' AND worker_id = ?`,
      )
      .run(
        state.startingHead ?? null,
        state.startingRemoteSha ?? null,
        state.endingHead ?? null,
        state.endingRemoteSha ?? null,
        state.changedFiles ? JSON.stringify(state.changedFiles) : null,
        state.commitMetadata ? JSON.stringify(state.commitMetadata) : null,
        this.now().toISOString(),
        work.executionId,
        this.workerId,
      );
  }

  private reportExecutionEvent(
    work: WorkRow,
    kind: CodexEventKind,
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    const now = this.now().toISOString();
    this.database.sqlite
      .prepare(
        `INSERT INTO execution_events
         (id, execution_id, sequence, kind, message, metadata, created_at)
         SELECT ?, ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ?, ?
         FROM execution_events WHERE execution_id = ?`,
      )
      .run(
        randomUUID(),
        work.executionId,
        kind,
        message.slice(0, 4_000),
        metadata ? JSON.stringify(metadata) : null,
        now,
        work.executionId,
      );
  }

  private beginRetry(work: WorkRow, reason: string): void {
    const now = this.now().toISOString();
    this.database.sqlite
      .transaction(() => {
        transitionTaskInTransaction(this.database.sqlite, {
          taskId: work.id,
          newStatus: 'retrying',
          expectedStatus: 'running',
          reason: `Retrying the same Codex thread: ${reason}`,
          executionId: work.executionId,
          correlationId: work.correlationId,
          now,
        });
        this.database.sqlite
          .prepare(
            'UPDATE executions SET retry_count = retry_count + 1, updated_at = ? WHERE id = ?',
          )
          .run(now, work.executionId);
        transitionTaskInTransaction(this.database.sqlite, {
          taskId: work.id,
          newStatus: 'running',
          expectedStatus: 'retrying',
          reason: 'Same-thread Codex retry started.',
          executionId: work.executionId,
          correlationId: work.correlationId,
          now,
        });
      })
      .immediate();
  }

  private resetShutdownMarker(): void {
    const now = this.now().toISOString();
    this.database.sqlite
      .prepare('UPDATE worker_lease SET shutting_down = false, updated_at = ? WHERE key = ?')
      .run(now, leaseKey);
  }

  private logContext(work: Pick<WorkRow, 'id' | 'executionId' | 'correlationId'>) {
    return {
      component: 'scheduler',
      workerId: this.workerId,
      taskId: work.id,
      executionId: work.executionId,
      correlationId: work.correlationId,
    };
  }
}

export function schedulerConfigFromEnvironment(): Partial<SchedulerConfig> {
  const config: Partial<SchedulerConfig> = {};
  const values: Array<[keyof SchedulerConfig, string | undefined]> = [
    ['pollIntervalMs', process.env.PHANTOM_SCHEDULER_INTERVAL_MS],
    ['heartbeatIntervalMs', process.env.PHANTOM_HEARTBEAT_INTERVAL_MS],
    ['staleAfterMs', process.env.PHANTOM_STALE_EXECUTION_MS],
    ['leaseDurationMs', process.env.PHANTOM_LEASE_DURATION_MS],
  ];
  for (const [key, value] of values) {
    const parsed = positiveInteger(value);
    if (parsed !== undefined) config[key] = parsed;
  }
  return config;
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseRecoveryMetadata(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function markInitialTaskEvent(
  sqlite: Database.Database,
  taskId: string,
  now: string,
  reason = 'Task created.',
): void {
  sqlite
    .prepare(
      `INSERT INTO task_events
       (id, task_id, execution_id, previous_status, new_status, reason, correlation_id, created_at)
       VALUES (?, ?, NULL, NULL, 'queued', ?, ?, ?)`,
    )
    .run(randomUUID(), taskId, reason, randomUUID(), now);
}

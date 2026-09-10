import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import type {
  CodexEventKind,
  ClassifierHealth,
  ComplexityClass,
  ModelTier,
  QuotaSnapshot,
  QuotaStatus,
  QuotaUsageDelta,
  ReasoningLevel,
  TaskPriority,
  TaskStatus,
  WorkerHealth,
} from '@phantom/shared';

import {
  DeterministicTaskClassifier,
  type ClassificationResult,
  type TaskClassifier,
} from './classifier.js';
import type { PhantomDatabase } from './db/index.js';
import {
  FakeExecutor,
  SimulatedCrashError,
  type ExecutorTask,
  type TaskExecutor,
} from './fake-executor.js';
import { transitionTaskInTransaction } from './task-state.js';
import {
  calculateQuotaDeltas,
  defaultQuotaPolicyConfig,
  evaluateQuotaGate,
  isQuotaSnapshotFresh,
  quotaPolicyConfigFromEnvironment,
  quotaResetWait,
  UnlimitedQuotaProvider,
  type QuotaPolicyConfig,
  type QuotaProvider,
} from './quota-policy.js';
import {
  modelPolicyFromEnvironment,
  refineQuotaEstimate,
  resolveModelSelection,
  StaticModelCatalogProvider,
  type CodexModelInfo,
  type ModelCatalogProvider,
  type ModelPolicy,
  type QuotaEstimate,
} from './model-policy.js';

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
  quotaBefore: QuotaSnapshot;
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
  status: TaskStatus;
  complexity: ComplexityClass;
  classification: string | null;
  classifierVersion: string | null;
  classificationSource: 'ollama' | 'deterministic' | null;
  classifierFallbackUsed: number;
  modelTier: ModelTier | null;
  selectedModel: string | null;
  selectedReasoning: ReasoningLevel | null;
  modelFallbackUsed: number;
  modelSelectionRationale: string | null;
  quotaEstimatePercent: number | null;
  quotaEstimateSource: 'baseline' | 'historical' | null;
  quotaEstimateSampleCount: number;
  quotaWaitUntil: string | null;
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
  private tickWaiters: Array<() => void> = [];
  private stopping = false;
  private activeWork: WorkRow | null = null;
  private activePromise: Promise<void> | null = null;
  private abortController: AbortController | null = null;
  private quotaWakeTimer: NodeJS.Timeout | null = null;
  private latestQuotaSnapshot: QuotaSnapshot | null = null;
  private quotaError: string | null = null;
  private unsubscribeQuota: (() => void) | null = null;

  constructor(
    private readonly database: PhantomDatabase,
    options: {
      workerId?: string;
      executor?: TaskExecutor;
      config?: Partial<SchedulerConfig>;
      logger?: SchedulerLogger;
      now?: () => Date;
      quotaProvider?: QuotaProvider;
      quotaPolicy?: Partial<QuotaPolicyConfig>;
      classifier?: TaskClassifier;
      modelCatalogProvider?: ModelCatalogProvider;
      modelPolicy?: ModelPolicy;
    } = {},
  ) {
    this.workerId = options.workerId ?? `worker-${randomUUID()}`;
    this.config = { ...defaultSchedulerConfig, ...options.config };
    this.executor = options.executor ?? new FakeExecutor();
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? (() => new Date());
    this.quotaProvider = options.quotaProvider ?? new UnlimitedQuotaProvider(this.now);
    this.classifier = options.classifier ?? new DeterministicTaskClassifier();
    this.modelPolicy = options.modelPolicy ?? modelPolicyFromEnvironment();
    this.modelCatalogProvider =
      options.modelCatalogProvider ?? new StaticModelCatalogProvider(this.modelPolicy);
    const environmentQuotaPolicy = quotaPolicyConfigFromEnvironment();
    this.quotaPolicy = {
      ...defaultQuotaPolicyConfig,
      ...environmentQuotaPolicy,
      ...options.quotaPolicy,
      estimatePercentByComplexity: {
        ...defaultQuotaPolicyConfig.estimatePercentByComplexity,
        ...environmentQuotaPolicy.estimatePercentByComplexity,
        ...options.quotaPolicy?.estimatePercentByComplexity,
      },
    };
    this.unsubscribeQuota =
      this.quotaProvider.subscribe?.((snapshot) => {
        this.persistQuotaSnapshot(snapshot);
        this.latestQuotaSnapshot = snapshot;
        this.quotaError = null;
      }) ?? null;
  }

  private readonly executor: TaskExecutor;
  private readonly logger: SchedulerLogger;
  private readonly now: () => Date;
  private readonly quotaProvider: QuotaProvider;
  private readonly quotaPolicy: QuotaPolicyConfig;
  private readonly classifier: TaskClassifier;
  private readonly modelCatalogProvider: ModelCatalogProvider;
  private readonly modelPolicy: ModelPolicy;
  private modelCatalogError: string | null = null;

  start(): void {
    if (this.timer || this.stopping) return;
    this.resetShutdownMarker();
    this.recoverStaleExecutions();
    this.scheduleNextQuotaWake();
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.pollIntervalMs);
    this.timer.unref();
  }

  async tick(): Promise<boolean> {
    if (this.stopping || this.tickInFlight) return false;
    this.tickInFlight = true;
    try {
      this.recoverStaleExecutions();
      await this.classifyNextQueuedTask();
      if (this.stopping) return false;
      const models = await this.refreshModelCatalog();
      if (!models) return false;
      const snapshot = await this.refreshQuota();
      if (this.stopping) return false;
      const work = this.acquireWork(snapshot, models);
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
      for (const resolve of this.tickWaiters.splice(0)) resolve();
      this.scheduleNextQuotaWake();
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.activePromise ?? Promise.resolve();
    if (!this.timer && !this.activeWork && !this.tickInFlight) {
      this.stopping = true;
      if (this.quotaWakeTimer) clearTimeout(this.quotaWakeTimer);
      this.quotaWakeTimer = null;
      this.unsubscribeQuota?.();
      this.unsubscribeQuota = null;
      await this.quotaProvider.close();
      return;
    }
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.quotaWakeTimer) clearTimeout(this.quotaWakeTimer);
    this.quotaWakeTimer = null;

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
    if (this.tickInFlight) {
      await new Promise<void>((resolve) => this.tickWaiters.push(resolve));
    }
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.unsubscribeQuota?.();
    this.unsubscribeQuota = null;
    await this.quotaProvider.close();
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
        `SELECT t.id, t.title, p.name AS projectName, t.priority, t.status AS taskStatus,
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
          taskStatus: TaskStatus;
        }
      | undefined;
    const next = this.selectNextDispatchableTask();
    const stale =
      current && this.now().getTime() - Date.parse(current.heartbeatAt) >= this.config.staleAfterMs;
    let status: WorkerHealth['status'] = 'idle';
    if (this.stopping || lease?.shuttingDown) status = 'stopping';
    else if (paused) status = 'paused';
    else if (current?.taskStatus === 'waiting_quota') status = 'waiting_quota';
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

  getQuotaStatus(): QuotaStatus {
    const snapshot = this.latestQuotaSnapshot ?? this.loadLatestQuotaSnapshot();
    return {
      snapshot,
      fresh: isQuotaSnapshotFresh(snapshot, this.now(), this.quotaPolicy.freshnessMs),
      staleAfterMs: this.quotaPolicy.freshnessMs,
      error: this.quotaError,
      reserves: {
        short: this.quotaPolicy.shortReservePercent,
        weekly: this.quotaPolicy.weeklyReservePercent,
      },
    };
  }

  checkClassifierHealth(): Promise<ClassifierHealth> {
    return this.classifier.checkHealth();
  }

  recoverStaleExecutions(): number {
    const now = this.now();
    const nowIso = now.toISOString();
    const staleBefore = new Date(now.getTime() - this.config.staleAfterMs).toISOString();
    const classificationStaleBefore = new Date(
      now.getTime() - Math.max(this.config.staleAfterMs, 2 * 60_000),
    ).toISOString();
    return this.database.sqlite
      .transaction(() => {
        const staleClassifications = this.database.sqlite
          .prepare(`SELECT id FROM tasks WHERE status = 'classifying' AND updated_at <= ?`)
          .all(classificationStaleBefore) as Array<{ id: string }>;
        for (const task of staleClassifications) {
          transitionTaskInTransaction(this.database.sqlite, {
            taskId: task.id,
            newStatus: 'queued',
            expectedStatus: 'classifying',
            reason: 'Stale local classification was recovered and requeued.',
            statusReason: null,
            now: nowIso,
          });
        }
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
        return stale.length + staleClassifications.length;
      })
      .immediate();
  }

  private async classifyNextQueuedTask(): Promise<boolean> {
    const now = this.now().toISOString();
    const task = this.database.sqlite
      .transaction(() => {
        const candidate = this.database.sqlite
          .prepare(
            `SELECT t.id, t.title, t.instructions, p.name AS projectName,
                    p.remote_branch AS remoteBranch
             FROM tasks t JOIN projects p ON p.id = t.project_id
             WHERE t.status = 'queued' AND t.classifier_version IS NULL AND p.enabled = true
             ORDER BY CASE t.priority
               WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
               t.created_at, t.id
             LIMIT 1`,
          )
          .get() as
          | {
              id: string;
              title: string;
              instructions: string;
              projectName: string;
              remoteBranch: string;
            }
          | undefined;
        if (!candidate) return undefined;
        transitionTaskInTransaction(this.database.sqlite, {
          taskId: candidate.id,
          newStatus: 'classifying',
          expectedStatus: 'queued',
          reason: 'Local complexity classification started.',
          now,
        });
        return candidate;
      })
      .immediate();
    if (!task) return false;

    let result: ClassificationResult;
    try {
      result = await this.classifier.classify(task);
    } catch (error) {
      const deterministic = await new DeterministicTaskClassifier().classify(task);
      result = { ...deterministic, fallbackUsed: true };
      this.logger.warn(
        {
          component: 'classifier',
          taskId: task.id,
          error: error instanceof Error ? error.message : String(error),
        },
        'Classifier failed unexpectedly; deterministic fallback used.',
      );
    }
    const completedAt = this.now().toISOString();
    const classification = result.classification;
    const baseline =
      this.quotaPolicy.estimatePercentByComplexity[classification.estimatedQuotaClass];
    this.database.sqlite
      .transaction(() => {
        const current = this.database.sqlite
          .prepare('SELECT status FROM tasks WHERE id = ?')
          .get(task.id) as { status: TaskStatus } | undefined;
        if (current?.status !== 'classifying') return;
        this.database.sqlite
          .prepare(
            `UPDATE tasks SET complexity = ?, classification = ?, classifier_version = ?,
               classification_source = ?, classifier_fallback_used = ?, model_tier = ?,
               selected_model = NULL, selected_reasoning = NULL, model_fallback_used = false,
               model_selection_rationale = NULL, quota_estimate_percent = ?,
               quota_estimate_source = 'baseline', quota_estimate_sample_count = 0,
               updated_at = ? WHERE id = ?`,
          )
          .run(
            classification.complexity,
            JSON.stringify(classification),
            result.classifierVersion,
            result.source,
            result.fallbackUsed ? 1 : 0,
            classification.modelTier,
            baseline,
            completedAt,
            task.id,
          );
        transitionTaskInTransaction(this.database.sqlite, {
          taskId: task.id,
          newStatus: 'queued',
          expectedStatus: 'classifying',
          reason: `Classified as ${classification.complexity.replace('_', ' ')} / ${classification.modelTier}.`,
          statusReason: null,
          now: completedAt,
        });
      })
      .immediate();
    return true;
  }

  private async refreshModelCatalog(): Promise<CodexModelInfo[] | null> {
    try {
      const models = await this.modelCatalogProvider.listModels();
      if (!models.length) throw new Error('Codex returned no available models.');
      this.modelCatalogError = null;
      return models;
    } catch (error) {
      this.modelCatalogError = error instanceof Error ? error.message : String(error);
      const now = this.now().toISOString();
      const task = this.selectNextDispatchableTask();
      if (task) {
        this.database.sqlite
          .prepare('UPDATE tasks SET status_reason = ?, updated_at = ? WHERE id = ?')
          .run(`Model availability check failed: ${this.modelCatalogError}`, now, task.id);
      }
      this.logger.warn(
        { component: 'model-policy', workerId: this.workerId, error: this.modelCatalogError },
        'Codex model catalog unavailable; dispatch paused.',
      );
      return null;
    }
  }

  private acquireWork(
    snapshot: QuotaSnapshot | null,
    availableModels: CodexModelInfo[],
  ): WorkRow | null {
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
                    t.priority, t.attempt_count AS attemptCount, t.status,
                    COALESCE(e.complexity, t.complexity) AS complexity,
                    t.classification, t.classifier_version AS classifierVersion,
                    t.classification_source AS classificationSource,
                    t.classifier_fallback_used AS classifierFallbackUsed,
                    COALESCE(e.model_tier, t.model_tier) AS modelTier,
                    COALESCE(e.selected_model, t.selected_model) AS selectedModel,
                    COALESCE(e.selected_reasoning, t.selected_reasoning) AS selectedReasoning,
                    COALESCE(e.model_fallback_used, t.model_fallback_used) AS modelFallbackUsed,
                    COALESCE(e.model_selection_rationale, t.model_selection_rationale) AS modelSelectionRationale,
                    COALESCE(e.quota_estimate_percent, t.quota_estimate_percent) AS quotaEstimatePercent,
                    COALESCE(e.quota_estimate_source, t.quota_estimate_source) AS quotaEstimateSource,
                    COALESCE(e.quota_estimate_sample_count, t.quota_estimate_sample_count) AS quotaEstimateSampleCount,
                    t.quota_wait_until AS quotaWaitUntil
             FROM executions e
             JOIN tasks t ON t.id = e.task_id
             JOIN projects p ON p.id = t.project_id
             WHERE e.state = 'recovering'
               AND (e.quota_wait_until IS NULL OR e.quota_wait_until <= ?)
             ORDER BY e.created_at LIMIT 1`,
          )
          .get(nowIso) as RecoveringRow | undefined;
        if (recovering) {
          const modelSelection = recovering.modelTier
            ? resolveModelSelection(recovering.modelTier, availableModels, this.modelPolicy)
            : null;
          if (!modelSelection) {
            this.logger.warn(
              this.logContext({ ...recovering, correlationId: recovering.executionId }),
              'No non-downgrading configured model is currently available for recovery.',
            );
            this.releaseLease(nowIso, false);
            return null;
          }
          const decision = snapshot
            ? evaluateQuotaGate(
                snapshot,
                recovering.complexity,
                this.quotaPolicy,
                now,
                recovering.quotaEstimatePercent,
              )
            : null;
          if (!snapshot || !decision?.allowed) {
            const reason =
              decision?.reason ??
              `Live quota check failed; execution remains paused: ${this.quotaError ?? 'quota provider unavailable'}`;
            const waitUntil =
              decision?.waitUntil ??
              new Date(now.getTime() + this.quotaPolicy.providerRetryDelayMs).toISOString();
            this.deferRecoveringExecution(recovering, reason, waitUntil, nowIso);
            this.releaseLease(nowIso, false);
            return null;
          }
          const correlationId = recovering.executionId;
          const resumeReason: 'quota_reset' | 'worker_recovery' =
            recovering.status === 'waiting_quota' ? 'quota_reset' : 'worker_recovery';
          const previous = parseRecoveryMetadata(recovering.recoveryMetadata);
          const metadata = JSON.stringify({
            ...previous,
            resumedAt: nowIso,
            resumeWorkerId: this.workerId,
            resumeReason,
          });
          sqlite
            .prepare(
              `UPDATE executions SET state = 'running', worker_id = ?, heartbeat_at = ?,
                 recovery_count = recovery_count + 1, recovery_metadata = ?,
                 quota_before_snapshot_id = COALESCE(quota_before_snapshot_id, ?),
                 model_tier = ?, selected_model = ?, selected_reasoning = ?,
                 model_fallback_used = ?, model_selection_rationale = ?,
                 quota_wait_until = NULL, updated_at = ?
               WHERE id = ? AND state = 'recovering'`,
            )
            .run(
              this.workerId,
              nowIso,
              metadata,
              snapshot.id,
              modelSelection.tier,
              modelSelection.model,
              modelSelection.reasoning,
              modelSelection.fallbackUsed ? 1 : 0,
              modelSelection.rationale,
              nowIso,
              recovering.executionId,
            );
          if (recovering.status === 'waiting_quota') {
            transitionTaskInTransaction(sqlite, {
              taskId: recovering.id,
              newStatus: 'running',
              expectedStatus: 'waiting_quota',
              reason: 'Live quota refreshed after reset; resuming the same Codex thread.',
              executionId: recovering.executionId,
              correlationId,
              now: nowIso,
            });
            sqlite
              .prepare('UPDATE tasks SET quota_wait_until = NULL WHERE id = ?')
              .run(recovering.id);
          }
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
            modelTier: modelSelection.tier,
            selectedModel: modelSelection.model,
            selectedReasoning: modelSelection.reasoning,
            modelFallbackUsed: modelSelection.fallbackUsed ? 1 : 0,
            modelSelectionRationale: modelSelection.rationale,
            correlationId,
            recoveryCount: recovering.recoveryCount + 1,
            resumeReason,
            quotaBefore: snapshot,
          };
        }

        const task = this.selectNextDispatchableTask();
        if (!task) {
          sqlite
            .prepare(
              `UPDATE worker_lease SET worker_id = NULL, execution_id = NULL,
                 lease_expires_at = NULL, updated_at = ? WHERE key = ?`,
            )
            .run(nowIso, leaseKey);
          return null;
        }

        if (!task.modelTier) {
          this.releaseLease(nowIso, false);
          return null;
        }
        const modelSelection = resolveModelSelection(
          task.modelTier,
          availableModels,
          this.modelPolicy,
        );
        if (!modelSelection) {
          sqlite
            .prepare('UPDATE tasks SET status_reason = ?, updated_at = ? WHERE id = ?')
            .run(
              `No configured ${task.modelTier}-or-higher Codex model with the requested reasoning effort is available.`,
              nowIso,
              task.id,
            );
          this.releaseLease(nowIso, false);
          return null;
        }
        const estimate = this.estimateQuotaFor(modelSelection.model, task.complexity);
        sqlite
          .prepare(
            `UPDATE tasks SET model_tier = ?, selected_model = ?, selected_reasoning = ?,
               model_fallback_used = ?, model_selection_rationale = ?, quota_estimate_percent = ?,
               quota_estimate_source = ?, quota_estimate_sample_count = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            modelSelection.tier,
            modelSelection.model,
            modelSelection.reasoning,
            modelSelection.fallbackUsed ? 1 : 0,
            modelSelection.rationale,
            estimate.percent,
            estimate.source,
            estimate.sampleCount,
            nowIso,
            task.id,
          );
        const dispatchTask: QueuedTaskRow = {
          ...task,
          modelTier: modelSelection.tier,
          selectedModel: modelSelection.model,
          selectedReasoning: modelSelection.reasoning,
          modelFallbackUsed: modelSelection.fallbackUsed ? 1 : 0,
          modelSelectionRationale: modelSelection.rationale,
          quotaEstimatePercent: estimate.percent,
          quotaEstimateSource: estimate.source,
          quotaEstimateSampleCount: estimate.sampleCount,
        };

        const decision = snapshot
          ? evaluateQuotaGate(
              snapshot,
              dispatchTask.complexity,
              this.quotaPolicy,
              now,
              dispatchTask.quotaEstimatePercent,
            )
          : null;
        if (!snapshot || !decision?.allowed) {
          const reason =
            decision?.reason ??
            `Live quota check failed; task was not dispatched: ${this.quotaError ?? 'quota provider unavailable'}`;
          const waitUntil =
            decision?.waitUntil ??
            new Date(now.getTime() + this.quotaPolicy.providerRetryDelayMs).toISOString();
          this.deferTaskBeforeExecution(dispatchTask, reason, waitUntil, nowIso);
          this.releaseLease(nowIso, false);
          return null;
        }

        const executionId = randomUUID();
        const attemptNumber = task.attemptCount + 1;
        sqlite
          .prepare(
            `INSERT INTO executions
              (id, task_id, attempt_number, state, worker_id, started_at, heartbeat_at,
               recovery_count, quota_before_snapshot_id, complexity, model_tier, selected_model,
               selected_reasoning, model_fallback_used, classifier_version,
               classifier_fallback_used, classification, model_selection_rationale,
               quota_estimate_percent, quota_estimate_source, quota_estimate_sample_count,
               created_at, updated_at)
             VALUES (?, ?, ?, 'running', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            executionId,
            task.id,
            attemptNumber,
            this.workerId,
            nowIso,
            nowIso,
            snapshot.id,
            dispatchTask.complexity,
            dispatchTask.modelTier,
            dispatchTask.selectedModel,
            dispatchTask.selectedReasoning,
            dispatchTask.modelFallbackUsed,
            dispatchTask.classifierVersion,
            dispatchTask.classifierFallbackUsed,
            dispatchTask.classification,
            dispatchTask.modelSelectionRationale,
            dispatchTask.quotaEstimatePercent,
            dispatchTask.quotaEstimateSource,
            dispatchTask.quotaEstimateSampleCount,
            nowIso,
            nowIso,
          );
        sqlite
          .prepare('UPDATE tasks SET attempt_count = ?, quota_wait_until = NULL WHERE id = ?')
          .run(attemptNumber, task.id);
        transitionTaskInTransaction(sqlite, {
          taskId: task.id,
          newStatus: 'running',
          expectedStatus: task.status,
          reason:
            task.status === 'waiting_quota'
              ? 'Quota reserve is available; task dispatched.'
              : 'Fresh quota check passed; acquired by the Codex executor.',
          executionId,
          correlationId: executionId,
          now: nowIso,
        });
        this.claimLease(executionId, nowIso, leaseExpiresAt);
        const work = {
          ...dispatchTask,
          executionId,
          attemptNumber,
          recoveryCount: 0,
          codexThreadId: null,
          retryCount: 0,
          startingHead: null,
          startingRemoteSha: null,
          resumeReason: null,
          correlationId: executionId,
          quotaBefore: snapshot,
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
      const after = await this.refreshQuota();
      this.recordQuotaAfter(work, after);
      if (this.stopping) return;
      if (result.status === 'waiting_quota') {
        const reason = result.reason || 'Codex reported that quota is exhausted.';
        this.reportExecutionEvent(work, 'failure', reason, {
          category: 'rate_limit',
          quotaWait: true,
        });
        this.waitForQuota(work, reason, after, {
          finalResult: result.finalResult,
          tokenUsage: result.tokenUsage,
          rawLogPath: result.rawLogPath,
        });
        return;
      }
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
      const after = await this.refreshQuota();
      this.recordQuotaAfter(work, after);
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

  private selectNextDispatchableTask(): QueuedTaskRow | undefined {
    const now = this.now().toISOString();
    return this.database.sqlite
      .prepare(
        `SELECT t.id, t.title, t.instructions, t.project_id AS projectId,
                p.name AS projectName, p.local_path AS projectPath,
                p.remote_name AS remoteName, p.remote_branch AS remoteBranch,
                t.priority, t.attempt_count AS attemptCount, t.status,
                t.complexity, t.classification,
                t.classifier_version AS classifierVersion,
                t.classification_source AS classificationSource,
                t.classifier_fallback_used AS classifierFallbackUsed,
                t.model_tier AS modelTier, t.selected_model AS selectedModel,
                t.selected_reasoning AS selectedReasoning,
                t.model_fallback_used AS modelFallbackUsed,
                t.model_selection_rationale AS modelSelectionRationale,
                t.quota_estimate_percent AS quotaEstimatePercent,
                t.quota_estimate_source AS quotaEstimateSource,
                t.quota_estimate_sample_count AS quotaEstimateSampleCount,
                t.quota_wait_until AS quotaWaitUntil
         FROM tasks t JOIN projects p ON p.id = t.project_id
         WHERE t.status IN ('queued', 'waiting_quota') AND p.enabled = true
           AND t.classifier_version IS NOT NULL
           AND (t.quota_wait_until IS NULL OR t.quota_wait_until <= ?)
           AND NOT EXISTS (
             SELECT 1 FROM executions e WHERE e.task_id = t.id AND e.state = 'recovering'
           )
         ORDER BY CASE t.priority
           WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
           t.created_at, t.id
         LIMIT 1`,
      )
      .get(now) as QueuedTaskRow | undefined;
  }

  private estimateQuotaFor(model: string, complexity: ComplexityClass): QuotaEstimate {
    const rows = this.database.sqlite
      .prepare(
        `SELECT quota_usage_delta AS quotaUsageDelta
         FROM executions
         WHERE state = 'completed' AND selected_model = ? AND complexity = ?
           AND quota_usage_delta IS NOT NULL
         ORDER BY finished_at DESC LIMIT 100`,
      )
      .all(model, complexity) as Array<{ quotaUsageDelta: string }>;
    const samples = rows.map((row) => {
      try {
        return { quotaUsageDelta: JSON.parse(row.quotaUsageDelta) as QuotaUsageDelta[] };
      } catch {
        return { quotaUsageDelta: null };
      }
    });
    return refineQuotaEstimate(this.quotaPolicy.estimatePercentByComplexity[complexity], samples, {
      usableShortPercent: 100 - this.quotaPolicy.shortReservePercent,
    });
  }

  private async refreshQuota(): Promise<QuotaSnapshot | null> {
    try {
      const snapshot = await this.quotaProvider.read();
      this.persistQuotaSnapshot(snapshot);
      this.latestQuotaSnapshot = snapshot;
      this.quotaError = null;
      return snapshot;
    } catch (error) {
      this.quotaError = error instanceof Error ? error.message : 'Live quota check failed.';
      this.logger.warn(
        { component: 'quota', workerId: this.workerId, error: this.quotaError },
        'Live quota snapshot unavailable.',
      );
      return null;
    }
  }

  private persistQuotaSnapshot(snapshot: QuotaSnapshot): void {
    const sqlite = this.database.sqlite;
    sqlite
      .transaction(() => {
        const inserted = sqlite
          .prepare(
            `INSERT OR IGNORE INTO quota_snapshots
             (id, account_id, source, observed_at, created_at) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            snapshot.id,
            snapshot.accountId,
            snapshot.source,
            snapshot.observedAt,
            this.now().toISOString(),
          );
        if (inserted.changes === 0) return;
        const statement = sqlite.prepare(
          `INSERT INTO quota_windows
           (id, snapshot_id, limit_id, limit_name, kind, used_percent, remaining_percent,
            window_duration_mins, resets_at, plan_type)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const window of snapshot.windows) {
          statement.run(
            randomUUID(),
            snapshot.id,
            window.limitId,
            window.limitName,
            window.kind,
            window.usedPercent,
            window.remainingPercent,
            window.windowDurationMins,
            window.resetsAt,
            window.planType,
          );
        }
      })
      .immediate();
  }

  private loadLatestQuotaSnapshot(): QuotaSnapshot | null {
    const snapshot = this.database.sqlite
      .prepare(
        `SELECT id, account_id AS accountId, source, observed_at AS observedAt
         FROM quota_snapshots ORDER BY observed_at DESC, rowid DESC LIMIT 1`,
      )
      .get() as Omit<QuotaSnapshot, 'windows'> | undefined;
    if (!snapshot) return null;
    const windows = this.database.sqlite
      .prepare(
        `SELECT limit_id AS limitId, limit_name AS limitName, kind,
                used_percent AS usedPercent, remaining_percent AS remainingPercent,
                window_duration_mins AS windowDurationMins, resets_at AS resetsAt,
                plan_type AS planType
         FROM quota_windows WHERE snapshot_id = ? ORDER BY limit_id, window_duration_mins`,
      )
      .all(snapshot.id) as QuotaSnapshot['windows'];
    return { ...snapshot, windows };
  }

  private recordQuotaAfter(work: WorkRow, after: QuotaSnapshot | null): void {
    const deltas = calculateQuotaDeltas(work.quotaBefore, after);
    const stored = this.database.sqlite
      .prepare('SELECT quota_usage_delta AS deltas FROM executions WHERE id = ?')
      .get(work.executionId) as { deltas: string | null } | undefined;
    const combined = [...parseQuotaDeltas(stored?.deltas), ...deltas];
    this.database.sqlite
      .prepare(
        `UPDATE executions SET quota_after_snapshot_id = ?, quota_usage_delta = ?, updated_at = ?
         WHERE id = ? AND state = 'running' AND worker_id = ?`,
      )
      .run(
        after?.id ?? null,
        JSON.stringify(combined),
        this.now().toISOString(),
        work.executionId,
        this.workerId,
      );
    if (after) {
      this.reportExecutionEvent(work, 'usage', 'Live quota measured after execution.', {
        deltas,
        observedAt: after.observedAt,
      });
    }
  }

  private deferTaskBeforeExecution(
    task: QueuedTaskRow,
    reason: string,
    waitUntil: string,
    now: string,
  ): void {
    if (task.status === 'queued') {
      transitionTaskInTransaction(this.database.sqlite, {
        taskId: task.id,
        newStatus: 'waiting_quota',
        expectedStatus: 'queued',
        reason,
        statusReason: reason,
        correlationId: randomUUID(),
        now,
      });
    }
    this.database.sqlite
      .prepare(
        `UPDATE tasks SET status_reason = ?, quota_wait_until = ?, updated_at = ? WHERE id = ?`,
      )
      .run(reason, waitUntil, now, task.id);
  }

  private deferRecoveringExecution(
    execution: RecoveringRow,
    reason: string,
    waitUntil: string,
    now: string,
  ): void {
    this.database.sqlite
      .prepare(
        `UPDATE executions SET quota_wait_until = ?, recovery_metadata = ?, updated_at = ?
         WHERE id = ? AND state = 'recovering'`,
      )
      .run(
        waitUntil,
        JSON.stringify({
          ...parseRecoveryMetadata(execution.recoveryMetadata),
          reason: 'quota_wait',
          quotaReason: reason,
          waitUntil,
        }),
        now,
        execution.executionId,
      );
    if (execution.status === 'running') {
      transitionTaskInTransaction(this.database.sqlite, {
        taskId: execution.id,
        newStatus: 'waiting_quota',
        expectedStatus: 'running',
        reason,
        statusReason: reason,
        executionId: execution.executionId,
        correlationId: execution.executionId,
        now,
      });
    }
    this.database.sqlite
      .prepare(
        `UPDATE tasks SET status_reason = ?, quota_wait_until = ?, updated_at = ? WHERE id = ?`,
      )
      .run(reason, waitUntil, now, execution.id);
  }

  private waitForQuota(
    work: WorkRow,
    reason: string,
    snapshot: QuotaSnapshot | null,
    details: {
      finalResult?: unknown | undefined;
      tokenUsage?: unknown | undefined;
      rawLogPath?: string | undefined;
    },
  ): void {
    const now = this.now();
    const nowIso = now.toISOString();
    const waitUntil = quotaResetWait(snapshot ?? work.quotaBefore, now, this.quotaPolicy);
    this.database.sqlite
      .transaction(() => {
        const owned = this.database.sqlite
          .prepare("SELECT id FROM executions WHERE id = ? AND state = 'running' AND worker_id = ?")
          .get(work.executionId, this.workerId);
        if (!owned) return;
        transitionTaskInTransaction(this.database.sqlite, {
          taskId: work.id,
          newStatus: 'waiting_quota',
          expectedStatus: 'running',
          reason: `${reason} Resume scheduled for ${waitUntil}.`,
          statusReason: reason,
          executionId: work.executionId,
          correlationId: work.correlationId,
          now: nowIso,
        });
        this.database.sqlite
          .prepare(`UPDATE tasks SET quota_wait_until = ?, updated_at = ? WHERE id = ?`)
          .run(waitUntil, nowIso, work.id);
        this.database.sqlite
          .prepare(
            `UPDATE executions SET state = 'recovering', worker_id = NULL,
               heartbeat_at = ?, recovery_metadata = ?, error = ?, quota_wait_until = ?,
               final_result = COALESCE(?, final_result), token_usage = COALESCE(?, token_usage),
               raw_log_path = COALESCE(?, raw_log_path), updated_at = ? WHERE id = ?`,
          )
          .run(
            nowIso,
            JSON.stringify({ reason: 'quota_wait', quotaReason: reason, waitUntil }),
            reason,
            waitUntil,
            details.finalResult ? JSON.stringify(details.finalResult) : null,
            details.tokenUsage ? JSON.stringify(details.tokenUsage) : null,
            details.rawLogPath ?? null,
            nowIso,
            work.executionId,
          );
        this.releaseLease(nowIso, false);
      })
      .immediate();
    this.logger.info(
      { ...this.logContext(work), reason, waitUntil },
      'Execution paused until quota reset.',
    );
  }

  private scheduleNextQuotaWake(): void {
    if (this.stopping || !this.timer) return;
    if (this.quotaWakeTimer) clearTimeout(this.quotaWakeTimer);
    this.quotaWakeTimer = null;
    const row = this.database.sqlite
      .prepare(
        `SELECT MIN(quota_wait_until) AS waitUntil FROM tasks
         WHERE status = 'waiting_quota' AND quota_wait_until IS NOT NULL`,
      )
      .get() as { waitUntil: string | null };
    if (!row.waitUntil) return;
    const delay = Math.max(0, Date.parse(row.waitUntil) - this.now().getTime());
    this.quotaWakeTimer = setTimeout(
      () => {
        this.quotaWakeTimer = null;
        void this.tick();
      },
      Math.min(delay, 2_147_483_647),
    );
    this.quotaWakeTimer.unref();
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

function parseQuotaDeltas(value: string | null | undefined): QuotaUsageDelta[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as QuotaUsageDelta[]) : [];
  } catch {
    return [];
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

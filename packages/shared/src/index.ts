import { z } from 'zod';

export const TASK_STATUSES = [
  'queued',
  'classifying',
  'waiting_quota',
  'running',
  'retrying',
  'completed',
  'failed',
  'blocked',
] as const;

export const TASK_PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;

export const taskStatusSchema = z.enum(TASK_STATUSES);
export const taskPrioritySchema = z.enum(TASK_PRIORITIES);

const trimmedText = (label: string, maximum: number) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .max(maximum, `${label} must be ${maximum} characters or fewer.`);

export const projectInputSchema = z.object({
  name: trimmedText('Project name', 100),
  localPath: trimmedText('Local path', 2048),
  remoteName: trimmedText('Remote name', 100).default('origin'),
  remoteBranch: trimmedText('Remote branch', 255).default('main'),
  enabled: z.boolean().default(true),
  validationCommands: z.array(trimmedText('Validation command', 1000)).max(20).default([]),
});

export const projectPatchSchema = z
  .object({
    name: trimmedText('Project name', 100).optional(),
    localPath: trimmedText('Local path', 2048).optional(),
    remoteName: trimmedText('Remote name', 100).optional(),
    remoteBranch: trimmedText('Remote branch', 255).optional(),
    enabled: z.boolean().optional(),
    validationCommands: z.array(trimmedText('Validation command', 1000)).max(20).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one project field must be supplied.',
  });

export const projectEnabledPatchSchema = z.object({ enabled: z.boolean() });

export const taskInputSchema = z.object({
  projectId: z.uuid('A valid project ID is required.'),
  title: trimmedText('Task title', 200),
  instructions: trimmedText('Instructions', 20_000),
  priority: taskPrioritySchema.default('normal'),
});

export const taskPatchSchema = z
  .object({
    title: trimmedText('Task title', 200).optional(),
    instructions: trimmedText('Instructions', 20_000).optional(),
    priority: taskPrioritySchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one task field must be supplied.',
  });

export const taskPriorityPatchSchema = z.object({ priority: taskPrioritySchema });
export const taskListQuerySchema = z.object({
  projectId: z.uuid('Project filter must be a valid ID.').optional(),
  status: taskStatusSchema.optional(),
});
export const workerSettingPatchSchema = z.object({ paused: z.boolean() });

export const EXECUTION_STATES = ['running', 'recovering', 'completed', 'failed'] as const;
export const executionStateSchema = z.enum(EXECUTION_STATES);

export const CODEX_RESULT_STATUSES = ['completed', 'incomplete', 'failed'] as const;
export const CODEX_FAILURE_CATEGORIES = [
  'none',
  'task',
  'environment',
  'authentication',
  'rate_limit',
  'timeout',
  'cancelled',
  'malformed_output',
] as const;

export const codexFinalResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(CODEX_RESULT_STATUSES),
    summary: trimmedText('Result summary', 4_000),
    completedItems: z.array(z.string().trim().min(1).max(2_000)).max(100),
    incompleteItems: z.array(z.string().trim().min(1).max(2_000)).max(100),
    failureCategory: z.enum(CODEX_FAILURE_CATEGORIES),
    failureReason: z.string().trim().max(8_000).nullable(),
    retryRecommended: z.boolean(),
    commitSha: z
      .string()
      .trim()
      .regex(/^[0-9a-f]{7,64}$/i)
      .nullable(),
    pushed: z.boolean(),
  })
  .superRefine((value, context) => {
    if (value.status === 'completed' && value.failureCategory !== 'none') {
      context.addIssue({
        code: 'custom',
        path: ['failureCategory'],
        message: 'Completed results must use the none failure category.',
      });
    }
    if (value.status !== 'completed' && !value.failureReason) {
      context.addIssue({
        code: 'custom',
        path: ['failureReason'],
        message: 'Non-completed results require a failure reason.',
      });
    }
  });

export const CODEX_EVENT_KINDS = [
  'thread',
  'progress',
  'command',
  'file_change',
  'usage',
  'failure',
  'final',
] as const;
export const codexEventKindSchema = z.enum(CODEX_EVENT_KINDS);

export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type TaskPriority = z.infer<typeof taskPrioritySchema>;
export type ProjectInput = z.infer<typeof projectInputSchema>;
export type ProjectPatch = z.infer<typeof projectPatchSchema>;
export type TaskInput = z.infer<typeof taskInputSchema>;
export type TaskPatch = z.infer<typeof taskPatchSchema>;
export type ExecutionState = z.infer<typeof executionStateSchema>;
export type CodexFinalResult = z.infer<typeof codexFinalResultSchema>;
export type CodexEventKind = z.infer<typeof codexEventKindSchema>;

export interface Project {
  id: string;
  name: string;
  localPath: string;
  remoteName: string;
  remoteBranch: string;
  enabled: boolean;
  validationCommands: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  instructions: string;
  priority: TaskPriority;
  status: TaskStatus;
  attemptCount: number;
  statusReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkerSetting {
  paused: boolean;
  updatedAt: string;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  executionId: string | null;
  previousStatus: TaskStatus | null;
  newStatus: TaskStatus;
  reason: string;
  correlationId: string;
  createdAt: string;
}

export interface Execution {
  id: string;
  taskId: string;
  attemptNumber: number;
  state: ExecutionState;
  workerId: string | null;
  startedAt: string;
  finishedAt: string | null;
  heartbeatAt: string;
  recoveryCount: number;
  recoveryMetadata: Record<string, unknown> | null;
  error: string | null;
  codexThreadId: string | null;
  retryCount: number;
  finalResult: CodexFinalResult | null;
  tokenUsage: TokenUsage | null;
  rawLogPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface ExecutionEvent {
  id: string;
  executionId: string;
  sequence: number;
  kind: CodexEventKind;
  message: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface WorkerTaskSummary {
  id: string;
  title: string;
  projectName: string;
  priority: TaskPriority;
}

export interface WorkerHealth {
  status: 'idle' | 'running' | 'paused' | 'stale' | 'stopping';
  workerId: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lastPollAt: string | null;
  heartbeatAt: string | null;
  currentTask: WorkerTaskSummary | null;
  nextEligibleTask: WorkerTaskSummary | null;
  paused: boolean;
  pollIntervalMs: number;
  staleAfterMs: number;
}

export interface HealthResponse {
  status: 'ok';
  database: 'connected';
  timestamp: string;
}

export interface VersionResponse {
  name: 'phantom';
  version: string;
  phase: 3;
}

export interface ApiError {
  error: string;
  details?: Array<{ path: string; message: string }>;
}

export const priorityRank: Record<TaskPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

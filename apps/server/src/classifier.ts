import {
  MODEL_TIERS,
  REASONING_LEVELS,
  RISK_LEVELS,
  RUNTIME_CLASSES,
  taskClassificationSchema,
  type ClassifierHealth,
  type ComplexityClass,
  type ModelTier,
  type ReasoningLevel,
  type RiskLevel,
  type RuntimeClass,
  type TaskClassification,
} from '@phantom/shared';

export const CLASSIFIER_VERSION = 'phase6-v1';

export interface ClassificationTask {
  title: string;
  instructions: string;
  projectName: string;
  remoteBranch: string;
}

export interface ClassificationResult {
  classification: TaskClassification;
  classifierVersion: string;
  source: 'ollama' | 'deterministic';
  fallbackUsed: boolean;
}

export interface TaskClassifier {
  classify(task: ClassificationTask): Promise<ClassificationResult>;
  checkHealth(): Promise<ClassifierHealth>;
}

export interface OllamaClassifierConfig {
  endpoint: string;
  model: string;
  timeoutMs: number;
  healthTimeoutMs: number;
  keepAlive: string;
  numGpu: number;
}

export const defaultOllamaClassifierConfig: OllamaClassifierConfig = {
  endpoint: 'http://127.0.0.1:11434',
  model: 'qwen2.5-coder:3b',
  timeoutMs: 60_000,
  healthTimeoutMs: 2_000,
  keepAlive: '5m',
  numGpu: 0,
};

export const classificationJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    complexity: { enum: ['small', 'medium', 'large', 'very_large'] },
    risk: { enum: RISK_LEVELS },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string' },
    modelTier: { enum: MODEL_TIERS },
    reasoningLevel: { enum: REASONING_LEVELS },
    estimatedRuntimeClass: { enum: RUNTIME_CLASSES },
    estimatedQuotaClass: { enum: ['small', 'medium', 'large', 'very_large'] },
    humanAttentionFlags: { type: 'array', items: { type: 'string' }, maxItems: 20 },
  },
  required: [
    'schemaVersion',
    'complexity',
    'risk',
    'confidence',
    'rationale',
    'modelTier',
    'reasoningLevel',
    'estimatedRuntimeClass',
    'estimatedQuotaClass',
    'humanAttentionFlags',
  ],
} as const;

const complexityRank: ComplexityClass[] = ['small', 'medium', 'large', 'very_large'];
const riskRank: RiskLevel[] = ['low', 'moderate', 'high', 'critical'];
const tierRank: ModelTier[] = ['economy', 'standard', 'advanced', 'premium'];
const reasoningRank: ReasoningLevel[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
const runtimeRank: RuntimeClass[] = ['quick', 'moderate', 'long', 'extended'];

interface SafetySignal {
  pattern: RegExp;
  score: number;
  risk: RiskLevel;
  flag: string;
}

const safetySignals: SafetySignal[] = [
  {
    pattern: /\b(migration|schema change|database schema|backfill)\b/i,
    score: 3,
    risk: 'high',
    flag: 'database-change',
  },
  {
    pattern: /\b(auth|authentication|authorization|oauth|credential|permission|security)\b/i,
    score: 3,
    risk: 'high',
    flag: 'security-sensitive',
  },
  {
    pattern: /\b(deploy|deployment|production|release|infrastructure|terraform)\b/i,
    score: 3,
    risk: 'high',
    flag: 'deployment',
  },
  {
    pattern: /\b(broad refactor|rewrite|across (the )?(repo|codebase)|entire codebase)\b/i,
    score: 3,
    risk: 'high',
    flag: 'broad-refactor',
  },
  {
    pattern:
      /\b(delete data|drop table|truncate|reset --hard|force[- ]push|destructive|irreversible)\b/i,
    score: 5,
    risk: 'critical',
    flag: 'destructive-operation',
  },
  {
    pattern: /\b(dependency upgrade|upgrade dependencies|major version|npm audit fix|lockfile)\b/i,
    score: 2,
    risk: 'moderate',
    flag: 'dependency-change',
  },
];

export class DeterministicTaskClassifier implements TaskClassifier {
  async classify(task: ClassificationTask): Promise<ClassificationResult> {
    return {
      classification: deterministicClassification(task),
      classifierVersion: CLASSIFIER_VERSION,
      source: 'deterministic',
      fallbackUsed: false,
    };
  }

  async checkHealth(): Promise<ClassifierHealth> {
    return {
      available: true,
      endpoint: 'deterministic://local',
      model: 'deterministic-rules',
      modelInstalled: true,
      checkedAt: new Date().toISOString(),
      latencyMs: 0,
      error: null,
    };
  }
}

export class OllamaTaskClassifier implements TaskClassifier {
  private health: ClassifierHealth | null = null;

  constructor(
    readonly config: OllamaClassifierConfig = defaultOllamaClassifierConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async checkHealth(): Promise<ClassifierHealth> {
    const startedAt = Date.now();
    try {
      const response = await fetchWithTimeout(
        this.fetcher,
        `${this.config.endpoint}/api/tags`,
        { method: 'GET' },
        this.config.healthTimeoutMs,
      );
      if (!response.ok) throw new Error(`Ollama health check returned HTTP ${response.status}.`);
      const body = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
      const names = (body.models ?? [])
        .flatMap((model) => [model.name, model.model])
        .filter(Boolean);
      const modelInstalled = names.some((name) => modelNamesMatch(String(name), this.config.model));
      this.health = {
        available: true,
        endpoint: this.config.endpoint,
        model: this.config.model,
        modelInstalled,
        checkedAt: this.now().toISOString(),
        latencyMs: Date.now() - startedAt,
        error: modelInstalled ? null : `Configured model ${this.config.model} is not installed.`,
      };
    } catch (error) {
      this.health = {
        available: false,
        endpoint: this.config.endpoint,
        model: this.config.model,
        modelInstalled: false,
        checkedAt: this.now().toISOString(),
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return this.health;
  }

  async classify(task: ClassificationTask): Promise<ClassificationResult> {
    const deterministic = deterministicClassification(task);
    try {
      const response = await fetchWithTimeout(
        this.fetcher,
        `${this.config.endpoint}/api/chat`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: this.config.model,
            stream: false,
            keep_alive: this.config.keepAlive,
            format: classificationJsonSchema,
            options: { temperature: 0, num_ctx: 4096, num_gpu: this.config.numGpu },
            messages: [
              { role: 'system', content: classifierSystemPrompt() },
              { role: 'user', content: classifierTaskPrompt(task) },
            ],
          }),
        },
        this.config.timeoutMs,
      );
      if (!response.ok) throw new Error(`Ollama classification returned HTTP ${response.status}.`);
      const body = (await response.json()) as { message?: { content?: unknown } };
      if (typeof body.message?.content !== 'string')
        throw new Error('Ollama returned no classification content.');
      const parsed = taskClassificationSchema.parse(
        normalizeLocalClassification(JSON.parse(body.message.content)),
      );
      return {
        classification: applySafetyOverrides(parsed, deterministic),
        classifierVersion: CLASSIFIER_VERSION,
        source: 'ollama',
        fallbackUsed: false,
      };
    } catch {
      return {
        classification: deterministic,
        classifierVersion: CLASSIFIER_VERSION,
        source: 'deterministic',
        fallbackUsed: true,
      };
    }
  }
}

export function ollamaClassifierConfigFromEnvironment(): OllamaClassifierConfig {
  return {
    endpoint: (
      process.env.PHANTOM_OLLAMA_ENDPOINT || defaultOllamaClassifierConfig.endpoint
    ).replace(/\/$/, ''),
    model: process.env.PHANTOM_OLLAMA_MODEL || defaultOllamaClassifierConfig.model,
    timeoutMs:
      positiveInteger(process.env.PHANTOM_OLLAMA_TIMEOUT_MS) ??
      defaultOllamaClassifierConfig.timeoutMs,
    healthTimeoutMs:
      positiveInteger(process.env.PHANTOM_OLLAMA_HEALTH_TIMEOUT_MS) ??
      defaultOllamaClassifierConfig.healthTimeoutMs,
    keepAlive: process.env.PHANTOM_OLLAMA_KEEP_ALIVE || defaultOllamaClassifierConfig.keepAlive,
    numGpu:
      nonNegativeInteger(process.env.PHANTOM_OLLAMA_NUM_GPU) ??
      defaultOllamaClassifierConfig.numGpu,
  };
}

export function deterministicClassification(task: ClassificationTask): TaskClassification {
  const text = `${task.title}\n${task.instructions}`;
  let score = text.length < 300 ? 0 : text.length < 1_500 ? 2 : text.length < 5_000 ? 5 : 8;
  const acceptanceSignals = text.match(/(^|\n)\s*(?:[-*]|\d+[.)]|\[[ x]\])\s+/g)?.length ?? 0;
  score += Math.min(3, Math.floor(acceptanceSignals / 3));
  if (/\b(test|verify|acceptance criteria|typecheck|lint|benchmark)\b/i.test(text)) score += 1;

  let risk: RiskLevel = 'low';
  const flags: string[] = [];
  for (const signal of safetySignals) {
    if (!signal.pattern.test(text)) continue;
    score += signal.score;
    risk = maxRank(risk, signal.risk, riskRank);
    flags.push(signal.flag);
  }

  const complexity: ComplexityClass =
    score <= 1 ? 'small' : score <= 5 ? 'medium' : score <= 9 ? 'large' : 'very_large';
  const tier = tierFor(complexity, risk);
  const rationale = [
    `Deterministic score ${score} from ${text.length} characters and ${acceptanceSignals} structured acceptance items.`,
    flags.length
      ? `Safety categories: ${flags.join(', ')}.`
      : 'No elevated safety category matched.',
  ].join(' ');
  return {
    schemaVersion: 1,
    complexity,
    risk,
    confidence: 0.72,
    rationale,
    modelTier: tier,
    reasoningLevel: reasoningForTier(tier),
    estimatedRuntimeClass: runtimeForComplexity(complexity),
    estimatedQuotaClass: complexity,
    humanAttentionFlags: [...new Set(flags)],
  };
}

export function applySafetyOverrides(
  local: TaskClassification,
  deterministic: TaskClassification,
): TaskClassification {
  const complexity = maxRank(local.complexity, deterministic.complexity, complexityRank);
  const risk = maxRank(local.risk, deterministic.risk, riskRank);
  const modelTier = maxRank(local.modelTier, tierFor(complexity, risk), tierRank);
  const overridden =
    complexity !== local.complexity ||
    risk !== local.risk ||
    modelTier !== local.modelTier ||
    complexityRank.indexOf(deterministic.estimatedQuotaClass) >
      complexityRank.indexOf(local.estimatedQuotaClass);
  return {
    ...local,
    complexity,
    risk,
    modelTier,
    reasoningLevel: maxRank(local.reasoningLevel, reasoningForTier(modelTier), reasoningRank),
    estimatedRuntimeClass: maxRank(
      local.estimatedRuntimeClass,
      runtimeForComplexity(complexity),
      runtimeRank,
    ),
    estimatedQuotaClass: maxRank(
      local.estimatedQuotaClass,
      deterministic.estimatedQuotaClass,
      complexityRank,
    ),
    humanAttentionFlags: [
      ...new Set([...local.humanAttentionFlags, ...deterministic.humanAttentionFlags]),
    ].slice(0, 20),
    rationale:
      local.rationale +
      (overridden ? ` Deterministic safety floor applied: ${deterministic.rationale}` : ''),
  };
}

export function normalizeLocalClassification(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = { ...(value as Record<string, unknown>) };
  if (typeof record.confidence === 'number' && record.confidence > 1 && record.confidence <= 100) {
    record.confidence /= 100;
  }
  return record;
}

export function classifierTaskPrompt(task: ClassificationTask): string {
  return [
    `Project: ${task.projectName}`,
    `Target branch: ${task.remoteBranch}`,
    `Task title: ${task.title}`,
    'Task instructions:',
    task.instructions,
  ].join('\n');
}

export function classifierSystemPrompt(): string {
  return [
    'Classify a software-engineering task for a local task scheduler.',
    'Return only data matching the supplied JSON schema.',
    'Estimate implementation breadth, operational risk, runtime, quota class, model tier, and reasoning effort.',
    'Confidence must be a decimal from 0.0 to 1.0, not a percentage from 0 to 100.',
    'Do not invent repository facts. The scheduler applies deterministic safety floors after your response.',
  ].join(' ');
}

function tierFor(complexity: ComplexityClass, risk: RiskLevel): ModelTier {
  if (risk === 'critical' || complexity === 'very_large') return 'premium';
  if (risk === 'high' || complexity === 'large') return 'advanced';
  if (risk === 'moderate' || complexity === 'medium') return 'standard';
  return 'economy';
}

function reasoningForTier(tier: ModelTier): ReasoningLevel {
  return tier === 'economy'
    ? 'low'
    : tier === 'standard'
      ? 'medium'
      : tier === 'advanced'
        ? 'high'
        : 'xhigh';
}

function runtimeForComplexity(complexity: ComplexityClass): RuntimeClass {
  return complexity === 'small'
    ? 'quick'
    : complexity === 'medium'
      ? 'moderate'
      : complexity === 'large'
        ? 'long'
        : 'extended';
}

function maxRank<T extends string>(left: T, right: T, order: readonly T[]): T {
  return order.indexOf(left) >= order.indexOf(right) ? left : right;
}

async function fetchWithTimeout(
  fetcher: typeof fetch,
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Request timed out.')), timeoutMs);
  timer.unref();
  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function modelNamesMatch(installed: string, configured: string): boolean {
  return (
    installed === configured ||
    installed.replace(/:latest$/, '') === configured.replace(/:latest$/, '')
  );
}

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function nonNegativeInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

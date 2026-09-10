import { randomUUID } from 'node:crypto';

import type {
  ComplexityClass,
  QuotaSnapshot,
  QuotaUsageDelta,
  QuotaWindow,
  QuotaWindowKind,
} from '@phantom/shared';

export interface RawRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface RawRateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: RawRateLimitWindow | null;
  secondary: RawRateLimitWindow | null;
  planType: string | null;
}

export interface RawRateLimitsResponse {
  rateLimits: RawRateLimitSnapshot;
  rateLimitsByLimitId: Record<string, RawRateLimitSnapshot | undefined> | null;
  accountId: string | null;
}

export interface QuotaProvider {
  read(): Promise<QuotaSnapshot>;
  subscribe?(listener: (snapshot: QuotaSnapshot) => void): () => void;
  close(): Promise<void>;
}

export interface QuotaPolicyConfig {
  shortReservePercent: number;
  weeklyReservePercent: number;
  estimatePercentByComplexity: Record<ComplexityClass, number>;
  freshnessMs: number;
  resetSafetyDelayMs: number;
  providerRetryDelayMs: number;
}

export const defaultQuotaPolicyConfig: QuotaPolicyConfig = {
  shortReservePercent: 15,
  weeklyReservePercent: 10,
  estimatePercentByComplexity: {
    small: 10,
    medium: 20,
    large: 35,
    very_large: 50,
  },
  freshnessMs: 30_000,
  resetSafetyDelayMs: 30_000,
  providerRetryDelayMs: 60_000,
};

export interface QuotaGateResult {
  allowed: boolean;
  reason: string;
  waitUntil: string | null;
  estimatedShortWindowPercent: number;
}

export function interpretRateLimits(
  response: RawRateLimitsResponse,
  observedAt: Date,
  source: QuotaSnapshot['source'] = 'read',
): QuotaSnapshot {
  const supplied = response.rateLimitsByLimitId
    ? Object.entries(response.rateLimitsByLimitId).filter(
        (entry): entry is [string, RawRateLimitSnapshot] => Boolean(entry[1]),
      )
    : [];
  const buckets: Array<[string, RawRateLimitSnapshot]> = supplied.length
    ? supplied
    : [[response.rateLimits.limitId ?? 'default', response.rateLimits]];
  const windows: QuotaWindow[] = [];

  for (const [mapKey, bucket] of buckets) {
    const limitId = bucket.limitId ?? mapKey;
    for (const window of [bucket.primary, bucket.secondary]) {
      if (!window) continue;
      windows.push({
        limitId,
        limitName: bucket.limitName,
        kind: classifyQuotaWindow(window.windowDurationMins),
        usedPercent: clampPercent(window.usedPercent),
        remainingPercent: clampPercent(100 - window.usedPercent),
        windowDurationMins: window.windowDurationMins,
        resetsAt: window.resetsAt === null ? null : new Date(window.resetsAt * 1_000).toISOString(),
        planType: bucket.planType,
      });
    }
  }

  return {
    id: randomUUID(),
    accountId: response.accountId,
    source,
    observedAt: observedAt.toISOString(),
    windows,
  };
}

export function classifyQuotaWindow(durationMins: number | null): QuotaWindowKind {
  if (durationMins === null || !Number.isFinite(durationMins) || durationMins <= 0) return 'other';
  if (durationMins <= 24 * 60) return 'short';
  if (durationMins >= 5 * 24 * 60 && durationMins <= 9 * 24 * 60) return 'weekly';
  return 'other';
}

export function isQuotaSnapshotFresh(
  snapshot: QuotaSnapshot | null,
  now: Date,
  freshnessMs: number,
): boolean {
  if (!snapshot) return false;
  const observedAt = Date.parse(snapshot.observedAt);
  return (
    Number.isFinite(observedAt) &&
    observedAt <= now.getTime() &&
    now.getTime() - observedAt <= freshnessMs
  );
}

export function evaluateQuotaGate(
  snapshot: QuotaSnapshot,
  complexity: ComplexityClass,
  config: QuotaPolicyConfig,
  now: Date,
): QuotaGateResult {
  if (!isQuotaSnapshotFresh(snapshot, now, config.freshnessMs)) {
    return blocked(
      'The quota snapshot is stale; dispatch is paused until live limits can be refreshed.',
      new Date(now.getTime() + config.providerRetryDelayMs),
      0,
    );
  }

  const short = snapshot.windows.filter((window) => window.kind === 'short');
  const weekly = snapshot.windows.filter((window) => window.kind === 'weekly');
  if (!short.length || !weekly.length) {
    return blocked(
      'Live quota data did not include both short and weekly windows.',
      new Date(now.getTime() + config.providerRetryDelayMs),
      0,
    );
  }

  const usableShort = 100 - config.shortReservePercent;
  const estimatedShort = (usableShort * config.estimatePercentByComplexity[complexity]) / 100;
  const blockers: QuotaWindow[] = [];
  for (const window of short) {
    if (window.remainingPercent < config.shortReservePercent + estimatedShort)
      blockers.push(window);
  }
  for (const window of weekly) {
    if (window.remainingPercent <= config.weeklyReservePercent) blockers.push(window);
  }

  if (!blockers.length) {
    return {
      allowed: true,
      reason: `Quota available for a ${complexity.replace('_', ' ')} task (estimated ${estimatedShort.toFixed(1)}% of the short window).`,
      waitUntil: null,
      estimatedShortWindowPercent: estimatedShort,
    };
  }

  const waitUntil = latestReset(blockers, now, config);
  const details = blockers
    .map(
      (window) =>
        `${window.limitId} ${window.kind} has ${window.remainingPercent.toFixed(1)}% remaining`,
    )
    .join('; ');
  return blocked(
    `Dispatch would violate configured quota reserves: ${details}.`,
    waitUntil,
    estimatedShort,
  );
}

export function quotaResetWait(
  snapshot: QuotaSnapshot | null,
  now: Date,
  config: QuotaPolicyConfig,
): string {
  const relevant = snapshot?.windows.filter(
    (window) => window.kind !== 'other' && window.remainingPercent <= 0,
  );
  const candidates = relevant?.length
    ? relevant
    : mostConstrainedWindows(snapshot?.windows.filter((window) => window.kind !== 'other') ?? []);
  return latestReset(candidates, now, config).toISOString();
}

export function calculateQuotaDeltas(
  before: QuotaSnapshot | null,
  after: QuotaSnapshot | null,
): QuotaUsageDelta[] {
  if (!before || !after) return [];
  const deltas: QuotaUsageDelta[] = [];
  for (const afterWindow of after.windows) {
    const beforeWindow = before.windows.find(
      (candidate) =>
        candidate.limitId === afterWindow.limitId &&
        candidate.kind === afterWindow.kind &&
        candidate.windowDurationMins === afterWindow.windowDurationMins,
    );
    if (!beforeWindow) continue;
    deltas.push({
      limitId: afterWindow.limitId,
      kind: afterWindow.kind,
      beforeUsedPercent: beforeWindow.usedPercent,
      afterUsedPercent: afterWindow.usedPercent,
      usedPercentDelta: Number((afterWindow.usedPercent - beforeWindow.usedPercent).toFixed(4)),
    });
  }
  return deltas;
}

export class UnlimitedQuotaProvider implements QuotaProvider {
  constructor(private readonly now: () => Date = () => new Date()) {}

  async read(): Promise<QuotaSnapshot> {
    const now = this.now();
    return {
      id: randomUUID(),
      accountId: null,
      source: 'read',
      observedAt: now.toISOString(),
      windows: [
        syntheticWindow('test', 'short', 300, now),
        syntheticWindow('test', 'weekly', 10_080, now),
      ],
    };
  }

  async close(): Promise<void> {}
}

export function quotaPolicyConfigFromEnvironment(): Partial<QuotaPolicyConfig> {
  const config: Partial<QuotaPolicyConfig> = {};
  assignPercent(config, 'shortReservePercent', process.env.PHANTOM_QUOTA_SHORT_RESERVE_PERCENT);
  assignPercent(config, 'weeklyReservePercent', process.env.PHANTOM_QUOTA_WEEKLY_RESERVE_PERCENT);
  assignPositive(config, 'freshnessMs', process.env.PHANTOM_QUOTA_FRESHNESS_MS);
  assignPositive(config, 'resetSafetyDelayMs', process.env.PHANTOM_QUOTA_RESET_DELAY_MS);
  assignPositive(config, 'providerRetryDelayMs', process.env.PHANTOM_QUOTA_RETRY_DELAY_MS);
  const estimates = { ...defaultQuotaPolicyConfig.estimatePercentByComplexity };
  let changed = false;
  for (const [complexity, suffix] of [
    ['small', 'SMALL'],
    ['medium', 'MEDIUM'],
    ['large', 'LARGE'],
    ['very_large', 'VERY_LARGE'],
  ] as const) {
    const value = parsePercent(process.env[`PHANTOM_QUOTA_ESTIMATE_${suffix}_PERCENT`]);
    if (value !== undefined) {
      estimates[complexity] = value;
      changed = true;
    }
  }
  if (changed) config.estimatePercentByComplexity = estimates;
  return config;
}

function latestReset(windows: QuotaWindow[], now: Date, config: QuotaPolicyConfig): Date {
  const resetTimes = windows
    .map((window) => (window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN))
    .filter((value) => Number.isFinite(value) && value > now.getTime());
  const base = resetTimes.length
    ? Math.max(...resetTimes)
    : now.getTime() + config.providerRetryDelayMs;
  return new Date(base + config.resetSafetyDelayMs);
}

function mostConstrainedWindows(windows: QuotaWindow[]): QuotaWindow[] {
  if (!windows.length) return [];
  const minimum = Math.min(...windows.map((window) => window.remainingPercent));
  return windows.filter((window) => window.remainingPercent === minimum);
}

function blocked(reason: string, waitUntil: Date, estimate: number): QuotaGateResult {
  return {
    allowed: false,
    reason,
    waitUntil: waitUntil.toISOString(),
    estimatedShortWindowPercent: estimate,
  };
}

function syntheticWindow(
  limitId: string,
  kind: 'short' | 'weekly',
  duration: number,
  now: Date,
): QuotaWindow {
  return {
    limitId,
    limitName: 'Unlimited test provider',
    kind,
    usedPercent: 0,
    remainingPercent: 100,
    windowDurationMins: duration,
    resetsAt: new Date(now.getTime() + duration * 60_000).toISOString(),
    planType: null,
  };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 100;
  return Math.min(100, Math.max(0, value));
}

function parsePercent(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed < 100 ? parsed : undefined;
}

function assignPercent<K extends 'shortReservePercent' | 'weeklyReservePercent'>(
  config: Partial<QuotaPolicyConfig>,
  key: K,
  value: string | undefined,
): void {
  const parsed = parsePercent(value);
  if (parsed !== undefined) config[key] = parsed;
}

function assignPositive<K extends 'freshnessMs' | 'resetSafetyDelayMs' | 'providerRetryDelayMs'>(
  config: Partial<QuotaPolicyConfig>,
  key: K,
  value: string | undefined,
): void {
  if (!value) return;
  const parsed = Number(value);
  if (Number.isSafeInteger(parsed) && parsed > 0) config[key] = parsed;
}

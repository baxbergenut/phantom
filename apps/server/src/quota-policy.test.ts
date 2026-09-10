import { describe, expect, it } from 'vitest';

import {
  calculateQuotaDeltas,
  classifyQuotaWindow,
  defaultQuotaPolicyConfig,
  evaluateQuotaGate,
  interpretRateLimits,
  isQuotaSnapshotFresh,
  quotaResetWait,
  type RawRateLimitsResponse,
} from './quota-policy.js';

const observedAt = new Date('2026-09-09T20:00:00.000Z');

describe('quota policy', () => {
  it('interprets multiple buckets and identifies windows by duration, not field order', () => {
    const response: RawRateLimitsResponse = {
      accountId: 'account-1',
      rateLimits: bucket('legacy', 1, 300, 2, 10_080),
      rateLimitsByLimitId: {
        premium: bucket('premium', 41, 10_080, 12, 300, 'pro'),
        codex: bucket('codex', 20, 300, 60, 10_080, 'plus'),
      },
    };

    const snapshot = interpretRateLimits(response, observedAt);

    expect(snapshot.accountId).toBe('account-1');
    expect(snapshot.windows).toHaveLength(4);
    expect(snapshot.windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ limitId: 'premium', kind: 'weekly', usedPercent: 41 }),
        expect.objectContaining({ limitId: 'premium', kind: 'short', usedPercent: 12 }),
        expect.objectContaining({ limitId: 'codex', kind: 'short', usedPercent: 20 }),
        expect.objectContaining({ limitId: 'codex', kind: 'weekly', usedPercent: 60 }),
      ]),
    );
  });

  it('classifies clock windows and rejects stale or future observations', () => {
    expect(classifyQuotaWindow(300)).toBe('short');
    expect(classifyQuotaWindow(10_080)).toBe('weekly');
    expect(classifyQuotaWindow(2_880)).toBe('other');
    const current = snapshot(20, 30, observedAt);
    expect(isQuotaSnapshotFresh(current, new Date(observedAt.getTime() + 30_000), 30_000)).toBe(
      true,
    );
    expect(isQuotaSnapshotFresh(current, new Date(observedAt.getTime() + 30_001), 30_000)).toBe(
      false,
    );
    expect(isQuotaSnapshotFresh(current, new Date(observedAt.getTime() - 1), 30_000)).toBe(false);
  });

  it('enforces short estimates plus reserve and the weekly reserve independently', () => {
    const config = { ...defaultQuotaPolicyConfig, freshnessMs: 60_000 };
    expect(
      evaluateQuotaGate(snapshot(20, 50, observedAt), 'medium', config, observedAt).allowed,
    ).toBe(true);
    const shortBlocked = evaluateQuotaGate(
      snapshot(69, 50, observedAt),
      'medium',
      config,
      observedAt,
    );
    expect(shortBlocked.allowed).toBe(false);
    expect(shortBlocked.reason).toContain('short');

    const weeklyBlocked = evaluateQuotaGate(
      snapshot(20, 90, observedAt),
      'small',
      config,
      observedAt,
    );
    expect(weeklyBlocked.allowed).toBe(false);
    expect(weeklyBlocked.reason).toContain('weekly');
  });

  it('waits for the latest blocking reset with a safety delay', () => {
    const current = snapshot(100, 100, observedAt);
    const wait = quotaResetWait(current, observedAt, {
      ...defaultQuotaPolicyConfig,
      resetSafetyDelayMs: 10_000,
    });
    expect(wait).toBe('2026-09-16T20:00:10.000Z');
  });

  it('records before and after deltas by bucket, kind, and duration', () => {
    const before = snapshot(20, 40, observedAt);
    const after = snapshot(24.5, 41, new Date(observedAt.getTime() + 1_000));
    expect(calculateQuotaDeltas(before, after)).toEqual([
      expect.objectContaining({ kind: 'short', usedPercentDelta: 4.5 }),
      expect.objectContaining({ kind: 'weekly', usedPercentDelta: 1 }),
    ]);
  });
});

function bucket(
  limitId: string,
  primaryUsed: number,
  primaryDuration: number,
  secondaryUsed: number,
  secondaryDuration: number,
  planType: string | null = null,
) {
  return {
    limitId,
    limitName: null,
    primary: {
      usedPercent: primaryUsed,
      windowDurationMins: primaryDuration,
      resetsAt: Math.floor(observedAt.getTime() / 1_000) + primaryDuration * 60,
    },
    secondary: {
      usedPercent: secondaryUsed,
      windowDurationMins: secondaryDuration,
      resetsAt: Math.floor(observedAt.getTime() / 1_000) + secondaryDuration * 60,
    },
    planType,
  };
}

function snapshot(shortUsed: number, weeklyUsed: number, at: Date) {
  return interpretRateLimits(
    {
      accountId: 'account-1',
      rateLimits: bucket('codex', shortUsed, 300, weeklyUsed, 10_080, 'plus'),
      rateLimitsByLimitId: null,
    },
    at,
  );
}

import type { QuotaUsageDelta } from '@phantom/shared';
import { describe, expect, it } from 'vitest';

import { defaultModelPolicy, refineQuotaEstimate, resolveModelSelection } from './model-policy.js';

describe('model selection policy', () => {
  it('uses the requested tier and only falls upward when it is unavailable', () => {
    const available = [
      { model: 'gpt-5.6-sol', supportedReasoningEfforts: ['high' as const] },
      { model: 'gpt-6-astra', supportedReasoningEfforts: ['high' as const] },
    ];
    expect(resolveModelSelection('advanced', available, defaultModelPolicy)).toMatchObject({
      tier: 'advanced',
      fallbackUsed: false,
    });
    expect(resolveModelSelection('standard', available, defaultModelPolicy)).toMatchObject({
      tier: 'advanced',
      fallbackUsed: true,
    });
    expect(resolveModelSelection('premium', available.slice(0, 1), defaultModelPolicy)).toBeNull();
  });

  it('requires enough samples and bounds the conservative percentile', () => {
    const sample = (value: number) => ({
      quotaUsageDelta: [
        {
          limitId: 'codex',
          kind: 'short',
          beforeUsedPercent: 10,
          afterUsedPercent: 10 + value,
          usedPercentDelta: value,
        } satisfies QuotaUsageDelta,
      ],
    });
    expect(refineQuotaEstimate(20, [sample(2), sample(3)])).toEqual({
      percent: 20,
      source: 'baseline',
      sampleCount: 2,
    });
    expect(
      refineQuotaEstimate(20, [
        {
          quotaUsageDelta: [1, 2, 3, 4, 5].map((value) => ({
            limitId: 'codex',
            kind: 'short' as const,
            beforeUsedPercent: 0,
            afterUsedPercent: value,
            usedPercentDelta: value,
          })),
        },
      ]),
    ).toMatchObject({ source: 'baseline', sampleCount: 1 });
    expect(
      refineQuotaEstimate(20, [sample(1), sample(2), sample(4), sample(100), sample(100)]),
    ).toEqual({
      percent: 30,
      source: 'historical',
      sampleCount: 5,
    });
  });
});

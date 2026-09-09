import { describe, expect, it } from 'vitest';

import { priorityRank, projectInputSchema, TASK_STATUSES, taskInputSchema } from './index.js';

describe('shared API contracts', () => {
  it('defines every lifecycle status centrally', () => {
    expect(TASK_STATUSES).toEqual([
      'queued',
      'classifying',
      'waiting_quota',
      'running',
      'retrying',
      'completed',
      'failed',
      'blocked',
    ]);
  });

  it('orders priorities from urgent to low', () => {
    expect(
      Object.entries(priorityRank)
        .sort((a, b) => a[1] - b[1])
        .map(([name]) => name),
    ).toEqual(['urgent', 'high', 'normal', 'low']);
  });

  it('rejects empty submissions and applies safe defaults', () => {
    expect(projectInputSchema.safeParse({}).success).toBe(false);
    expect(taskInputSchema.safeParse({}).success).toBe(false);
    const parsed = projectInputSchema.parse({ name: 'Example', localPath: 'C:\\example' });
    expect(parsed).toMatchObject({ remoteName: 'origin', remoteBranch: 'main', enabled: true });
  });
});

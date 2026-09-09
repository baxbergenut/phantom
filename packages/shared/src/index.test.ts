import { describe, expect, it } from 'vitest';

import {
  codexFinalResultSchema,
  priorityRank,
  projectInputSchema,
  TASK_STATUSES,
  taskInputSchema,
} from './index.js';

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

  it('validates semantic invariants in Codex final results', () => {
    const complete = {
      schemaVersion: 1,
      status: 'completed',
      summary: 'All requested work is complete.',
      completedItems: ['Implemented the change'],
      incompleteItems: [],
      failureCategory: 'none',
      failureReason: null,
      retryRecommended: false,
      commitSha: null,
      pushed: false,
    };
    expect(codexFinalResultSchema.safeParse(complete).success).toBe(true);
    expect(
      codexFinalResultSchema.safeParse({
        ...complete,
        status: 'failed',
        failureCategory: 'task',
      }).success,
    ).toBe(false);
  });
});

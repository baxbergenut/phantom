import { describe, expect, it, vi } from 'vitest';

import {
  applySafetyOverrides,
  classifierTaskPrompt,
  deterministicClassification,
  OllamaTaskClassifier,
  type ClassificationTask,
} from './classifier.js';

const task: ClassificationTask = {
  title: 'Update login flow',
  instructions: 'Change authentication and add a database migration. Verify the tests.',
  projectName: 'Example',
  remoteBranch: 'main',
};

describe('local task classifier', () => {
  it('classifies fixture sizes and raises risky categories deterministically', () => {
    expect(
      deterministicClassification({
        ...task,
        title: 'Fix typo',
        instructions: 'Correct one label.',
      }).complexity,
    ).toBe('small');
    const risky = deterministicClassification(task);
    expect(risky.risk).toBe('high');
    expect(['advanced', 'premium']).toContain(risky.modelTier);
    expect(risky.humanAttentionFlags).toEqual(
      expect.arrayContaining(['security-sensitive', 'database-change']),
    );
    expect(
      deterministicClassification({
        ...task,
        title: 'Rewrite platform',
        instructions: `${'Implement broad refactor across the codebase. '.repeat(150)} Deploy to production.`,
      }).complexity,
    ).toBe('very_large');
  });

  it('never lets a local response lower the deterministic safety floor', () => {
    const deterministic = deterministicClassification(task);
    const overlaid = applySafetyOverrides(
      {
        schemaVersion: 1,
        complexity: 'small',
        risk: 'low',
        confidence: 0.99,
        rationale: 'Looks easy.',
        modelTier: 'economy',
        reasoningLevel: 'low',
        estimatedRuntimeClass: 'quick',
        estimatedQuotaClass: 'small',
        humanAttentionFlags: [],
      },
      deterministic,
    );
    expect(overlaid.risk).toBe('high');
    expect(['advanced', 'premium']).toContain(overlaid.modelTier);
    expect(overlaid.humanAttentionFlags).toContain('security-sensitive');
  });

  it('uses valid structured Ollama output and sends only minimal project metadata', async () => {
    const local = {
      schemaVersion: 1,
      complexity: 'large',
      risk: 'high',
      confidence: 90,
      rationale: 'Touches security and persistence.',
      modelTier: 'advanced',
      reasoningLevel: 'high',
      estimatedRuntimeClass: 'long',
      estimatedQuotaClass: 'large',
      humanAttentionFlags: ['security-sensitive'],
    };
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      void _input;
      void _init;
      return new Response(JSON.stringify({ message: { content: JSON.stringify(local) } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const classifier = new OllamaTaskClassifier(undefined, fetcher as typeof fetch);
    const result = await classifier.classify(task);
    expect(result.source).toBe('ollama');
    expect(result.fallbackUsed).toBe(false);
    expect(result.classification.confidence).toBe(0.9);
    const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ content: string }>;
    };
    expect(request.messages[1]?.content).toBe(classifierTaskPrompt(task));
    expect(request.messages[1]?.content).not.toContain('C:\\');
  });

  it.each(['unavailable', 'timeout', 'malformed'] as const)(
    'falls back deterministically when Ollama is %s',
    async (mode) => {
      const fetcher: typeof fetch = async (_input, init) => {
        if (mode === 'unavailable') throw new Error('connect refused');
        if (mode === 'malformed') {
          return new Response(JSON.stringify({ message: { content: '{not-json' } }), {
            status: 200,
          });
        }
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      };
      const classifier = new OllamaTaskClassifier(
        {
          endpoint: 'http://127.0.0.1:11434',
          model: 'test:3b',
          timeoutMs: 5,
          healthTimeoutMs: 5,
          keepAlive: '0',
          numGpu: 0,
        },
        fetcher,
      );
      const result = await classifier.classify(task);
      expect(result.source).toBe('deterministic');
      expect(result.fallbackUsed).toBe(true);
      expect(result.classification.risk).toBe('high');
    },
  );
});

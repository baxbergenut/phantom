import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { CodexAppServerQuotaProvider } from './codex-app-server-quota.js';

const fixture = fileURLToPath(new URL('./test-fixtures/fake-app-server.cjs', import.meta.url));
const providers: CodexAppServerQuotaProvider[] = [];

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
});

describe('Codex App Server quota provider', () => {
  it('initializes, correlates reads, supports multiple buckets, and merges notifications', async () => {
    const provider = createProvider('notification');
    const notification = new Promise<Awaited<ReturnType<typeof provider.read>>>((resolve) => {
      provider.subscribe(resolve);
    });

    const initial = await provider.read();
    expect(initial.accountId).toBe('fake-account');
    expect(initial.windows).toHaveLength(4);
    expect(initial.windows.map((window) => window.limitId)).toEqual([
      'review',
      'review',
      'codex',
      'codex',
    ]);

    const updated = await notification;
    expect(updated.source).toBe('notification');
    expect(
      updated.windows.find((window) => window.limitId === 'codex' && window.kind === 'short')
        ?.usedPercent,
    ).toBe(25);
    expect(
      updated.windows.find((window) => window.limitId === 'codex' && window.kind === 'weekly')
        ?.usedPercent,
    ).toBe(55);
  });

  it('reconnects and retries a read after the protocol process exits', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'phantom-app-server-'));
    const marker = path.join(root, 'failed-once');
    try {
      const provider = createProvider('reconnect', marker);
      const snapshot = await provider.read();
      expect(snapshot.accountId).toBe('fake-account');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads model availability and supported reasoning efforts', async () => {
    const provider = createProvider('normal');
    await expect(provider.listModels()).resolves.toEqual([
      { model: 'gpt-5.6-terra', supportedReasoningEfforts: ['medium', 'high'] },
    ]);
  });

  it('times out unresponsive reads and closes cleanly', async () => {
    const provider = createProvider('timeout', undefined, 30);
    await expect(provider.read()).rejects.toThrow('timed out');
    await provider.close();
  });
});

function createProvider(mode: string, marker?: string, requestTimeoutMs = 1_000) {
  const provider = new CodexAppServerQuotaProvider({
    command: process.execPath,
    args: [fixture, mode, ...(marker ? [marker] : [])],
    requestTimeoutMs,
  });
  providers.push(provider);
  return provider;
}

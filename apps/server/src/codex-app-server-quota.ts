import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface as ReadLineInterface } from 'node:readline';

import type { QuotaSnapshot } from '@phantom/shared';

import {
  interpretRateLimits,
  type QuotaProvider,
  type RawRateLimitsResponse,
  type RawRateLimitSnapshot,
} from './quota-policy.js';

export interface CodexAppServerQuotaConfig {
  command: string;
  args: string[];
  requestTimeoutMs: number;
}

export const defaultCodexAppServerQuotaConfig: CodexAppServerQuotaConfig = {
  command: 'codex',
  args: ['app-server', '--stdio'],
  requestTimeoutMs: 10_000,
};

interface RpcResponse {
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class CodexAppServerQuotaProvider implements QuotaProvider {
  private child: ChildProcessWithoutNullStreams | null = null;
  private reader: ReadLineInterface | null = null;
  private connecting: Promise<void> | null = null;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private listeners = new Set<(snapshot: QuotaSnapshot) => void>();
  private lastRaw: RawRateLimitsResponse | null = null;
  private closing = false;

  constructor(
    private readonly config: CodexAppServerQuotaConfig = defaultCodexAppServerQuotaConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async read(): Promise<QuotaSnapshot> {
    let previousError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.ensureConnected();
        const result = await this.sendRequest('account/rateLimits/read');
        const raw = parseRateLimitsResponse(result);
        this.lastRaw = raw;
        return interpretRateLimits(raw, this.now(), 'read');
      } catch (error) {
        previousError = error;
        await this.disconnect();
      }
    }
    throw previousError instanceof Error
      ? previousError
      : new Error('Codex App Server quota read failed.');
  }

  subscribe(listener: (snapshot: QuotaSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closing = true;
    this.listeners.clear();
    await this.disconnect();
  }

  private async ensureConnected(): Promise<void> {
    if (this.closing) throw new Error('Codex App Server quota provider is closed.');
    if (this.child) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connect();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async connect(): Promise<void> {
    const child = spawn(this.config.command, this.config.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.reader.on('line', (line) => this.handleLine(line));
    child.stderr.resume();
    child.on('error', (error) => this.handleDisconnect(error));
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      const suffix = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      this.handleDisconnect(new Error(`Codex App Server exited with ${suffix}.`));
    });

    await new Promise<void>((resolve, reject) => {
      if (child.spawnfile && child.pid) {
        resolve();
        return;
      }
      child.once('spawn', resolve);
      child.once('error', reject);
    });

    await this.sendRequestDirect('initialize', {
      clientInfo: { name: 'phantom', title: 'Phantom', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.write({ method: 'initialized' });
  }

  private async sendRequest(method: string): Promise<unknown> {
    if (!this.child) throw new Error('Codex App Server is not connected.');
    return this.sendRequestDirect(method);
  }

  private sendRequestDirect(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request ${method} timed out.`));
      }, this.config.requestTimeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private write(message: Record<string, unknown>): void {
    if (!this.child?.stdin.writable) throw new Error('Codex App Server input is unavailable.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    const record = message as Record<string, unknown>;
    if (typeof record.id === 'number') {
      this.resolveResponse(record as unknown as RpcResponse);
      return;
    }
    if (record.method === 'account/rateLimits/updated') this.handleRateLimitUpdate(record.params);
  }

  private resolveResponse(response: RpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (response.error) {
      pending.reject(
        new Error(
          `Codex App Server error${response.error.code ? ` ${response.error.code}` : ''}: ${response.error.message ?? 'request failed'}`,
        ),
      );
      return;
    }
    pending.resolve(response.result);
  }

  private handleRateLimitUpdate(params: unknown): void {
    if (!this.lastRaw || !params || typeof params !== 'object') return;
    const candidate = (params as { rateLimits?: unknown }).rateLimits;
    const update = parseRateLimitSnapshot(candidate);
    if (!update) return;
    const limitId = update.limitId ?? this.lastRaw.rateLimits.limitId ?? 'default';
    const currentById = { ...(this.lastRaw.rateLimitsByLimitId ?? {}) };
    const previous =
      currentById[limitId] ??
      (this.lastRaw.rateLimits.limitId === limitId ? this.lastRaw.rateLimits : undefined);
    const merged = mergeBucket(previous, update);
    currentById[limitId] = merged;
    this.lastRaw = {
      ...this.lastRaw,
      rateLimits:
        this.lastRaw.rateLimits.limitId === limitId
          ? mergeBucket(this.lastRaw.rateLimits, update)
          : this.lastRaw.rateLimits,
      rateLimitsByLimitId: currentById,
    };
    const snapshot = interpretRateLimits(this.lastRaw, this.now(), 'notification');
    for (const listener of this.listeners) listener(snapshot);
  }

  private handleDisconnect(error: Error): void {
    const child = this.child;
    this.child = null;
    this.reader?.close();
    this.reader = null;
    if (child?.stdin.writable) child.stdin.end();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private async disconnect(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.reader?.close();
    this.reader = null;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Codex App Server connection closed.'));
    }
    this.pending.clear();
    if (!child || child.exitCode !== null) return;
    child.stdin.end();
    child.kill();
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        timer.unref();
      }),
    ]);
  }
}

export function codexAppServerQuotaConfigFromEnvironment(): CodexAppServerQuotaConfig {
  const timeout = Number(process.env.PHANTOM_QUOTA_REQUEST_TIMEOUT_MS);
  return {
    command: process.env.PHANTOM_CODEX_EXECUTABLE || defaultCodexAppServerQuotaConfig.command,
    args: defaultCodexAppServerQuotaConfig.args,
    requestTimeoutMs:
      Number.isSafeInteger(timeout) && timeout > 0
        ? timeout
        : defaultCodexAppServerQuotaConfig.requestTimeoutMs,
  };
}

function parseRateLimitsResponse(value: unknown): RawRateLimitsResponse {
  if (!value || typeof value !== 'object') throw new Error('Codex returned malformed quota data.');
  const record = value as Record<string, unknown>;
  const rateLimits = parseRateLimitSnapshot(record.rateLimits);
  if (!rateLimits) throw new Error('Codex quota data did not include a rate-limit bucket.');
  let rateLimitsByLimitId: Record<string, RawRateLimitSnapshot | undefined> | null = null;
  if (record.rateLimitsByLimitId && typeof record.rateLimitsByLimitId === 'object') {
    rateLimitsByLimitId = {};
    for (const [key, bucket] of Object.entries(record.rateLimitsByLimitId)) {
      const parsed = parseRateLimitSnapshot(bucket);
      if (parsed) rateLimitsByLimitId[key] = parsed;
    }
  }
  return {
    rateLimits,
    rateLimitsByLimitId,
    accountId: typeof record.accountId === 'string' ? record.accountId : null,
  };
}

function parseRateLimitSnapshot(value: unknown): RawRateLimitSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return {
    limitId: typeof record.limitId === 'string' ? record.limitId : null,
    limitName: typeof record.limitName === 'string' ? record.limitName : null,
    primary: parseWindow(record.primary),
    secondary: parseWindow(record.secondary),
    planType: typeof record.planType === 'string' ? record.planType : null,
  };
}

function parseWindow(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.usedPercent !== 'number') return null;
  return {
    usedPercent: record.usedPercent,
    windowDurationMins:
      typeof record.windowDurationMins === 'number' ? record.windowDurationMins : null,
    resetsAt: typeof record.resetsAt === 'number' ? record.resetsAt : null,
  };
}

function mergeBucket(
  previous: RawRateLimitSnapshot | undefined,
  update: RawRateLimitSnapshot,
): RawRateLimitSnapshot {
  if (!previous) return update;
  return {
    limitId: update.limitId ?? previous.limitId,
    limitName: update.limitName ?? previous.limitName,
    primary: update.primary ?? previous.primary,
    secondary: update.secondary ?? previous.secondary,
    planType: update.planType ?? previous.planType,
  };
}

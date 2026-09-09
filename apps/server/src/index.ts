import './load-env.js';

import path from 'node:path';

import { createApp } from './app.js';
import { CodexExecutor, codexExecutorConfigFromEnvironment } from './codex-executor.js';
import { resolveDatabasePath } from './db/index.js';
import { GitAdapter } from './git-adapter.js';

const host = process.env.PHANTOM_HOST || '127.0.0.1';
const port = Number(process.env.PHANTOM_PORT || 4310);
const databasePath = resolveDatabasePath();
const executor = new CodexExecutor(
  codexExecutorConfigFromEnvironment(path.join(path.dirname(databasePath), 'execution-logs')),
  new GitAdapter(),
);
const capability = await executor.checkCapabilities();
const app = await createApp({ logger: true, executor, databasePath });
app.log.info(capability, 'Codex capability check passed.');

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}

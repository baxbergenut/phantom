import './load-env.js';

import path from 'node:path';

import { createApp } from './app.js';
import { CodexExecutor, codexExecutorConfigFromEnvironment } from './codex-executor.js';
import {
  CodexAppServerQuotaProvider,
  codexAppServerQuotaConfigFromEnvironment,
} from './codex-app-server-quota.js';
import { resolveDatabasePath } from './db/index.js';
import { GitAdapter } from './git-adapter.js';
import { OllamaTaskClassifier, ollamaClassifierConfigFromEnvironment } from './classifier.js';
import { modelPolicyFromEnvironment } from './model-policy.js';

const host = process.env.PHANTOM_HOST || '127.0.0.1';
const port = Number(process.env.PHANTOM_PORT || 4310);
const databasePath = resolveDatabasePath();
const executor = new CodexExecutor(
  codexExecutorConfigFromEnvironment(path.join(path.dirname(databasePath), 'execution-logs')),
  new GitAdapter(),
);
const capability = await executor.checkCapabilities();
const quotaProvider = new CodexAppServerQuotaProvider(codexAppServerQuotaConfigFromEnvironment());
const classifier = new OllamaTaskClassifier(ollamaClassifierConfigFromEnvironment());
const classifierHealth = await classifier.checkHealth();
const modelPolicy = modelPolicyFromEnvironment();
const app = await createApp({
  logger: true,
  executor,
  quotaProvider,
  classifier,
  modelCatalogProvider: quotaProvider,
  modelPolicy,
  databasePath,
});
app.log.info(capability, 'Codex capability check passed.');
if (classifierHealth.available && classifierHealth.modelInstalled) {
  app.log.info(classifierHealth, 'Ollama classifier health check passed.');
} else {
  app.log.warn(
    classifierHealth,
    'Ollama classifier unavailable; deterministic fallback is active.',
  );
}

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}

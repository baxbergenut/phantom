import './load-env.js';

import { createApp } from './app.js';

const host = process.env.PHANTOM_HOST || '127.0.0.1';
const port = Number(process.env.PHANTOM_PORT || 4310);
const app = await createApp({ logger: true });

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}

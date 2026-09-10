/* eslint-disable @typescript-eslint/no-require-imports, no-undef */

const { existsSync, writeFileSync } = require('node:fs');
const readline = require('node:readline');

const mode = process.argv[2] || 'normal';
const marker = process.argv[3];
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({
      id: message.id,
      result: {
        userAgent: 'fake-codex/1.0',
        codexHome: 'C:\\fake',
        platformFamily: 'windows',
        platformOs: 'windows',
      },
    });
    return;
  }
  if (message.method !== 'account/rateLimits/read') return;
  if (mode === 'timeout') return;
  if (mode === 'reconnect' && marker && !existsSync(marker)) {
    writeFileSync(marker, 'failed-once');
    process.exit(17);
  }
  send({ id: message.id, result: response() });
  if (mode === 'notification') {
    setTimeout(
      () =>
        send({
          method: 'account/rateLimits/updated',
          params: {
            rateLimits: {
              limitId: 'codex',
              limitName: null,
              primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
              secondary: null,
              planType: null,
            },
          },
        }),
      5,
    );
  }
});

function response() {
  const codex = {
    limitId: 'codex',
    limitName: null,
    primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    secondary: { usedPercent: 55, windowDurationMins: 10080, resetsAt: 1_800_500_000 },
    planType: 'plus',
  };
  const review = {
    limitId: 'review',
    limitName: 'Code review',
    primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1_800_500_000 },
    planType: 'plus',
  };
  return {
    rateLimits: codex,
    rateLimitsByLimitId: { review, codex },
    rateLimitResetCredits: null,
    accountId: 'fake-account',
    rateLimitUpsell: null,
  };
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/* eslint-disable @typescript-eslint/no-require-imports, no-undef */

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex-cli 99.0.0-test');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  console.log('Logged in using test credentials');
  process.exit(0);
}
if (args[0] === 'exec' && args[1] === '--help') {
  console.log('--json --output-schema --output-last-message');
  process.exit(0);
}

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (prompt += chunk));
process.stdin.on('end', () => {
  const scenario = process.env.PHANTOM_FAKE_CODEX_SCENARIO || 'success';
  const resumed = args.includes('resume');
  const outputFlag = args.indexOf('--output-last-message');
  const outputPath = args[outputFlag + 1];
  console.log(JSON.stringify({ type: 'thread.started', thread_id: '0199-fixture-thread' }));
  console.log(
    JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text:
          scenario === 'secret'
            ? `Observed ${process.env.PHANTOM_TEST_API_KEY}`
            : resumed
              ? 'Retrying safely.'
              : 'Working safely.',
      },
    }),
  );
  if (scenario === 'timeout' || scenario === 'cancel') {
    setTimeout(() => {}, 60_000);
    return;
  }
  if (scenario === 'rate-limit') {
    console.log(JSON.stringify({ type: 'turn.failed', message: '429 quota rate limit reached' }));
    process.exit(1);
  }
  if (scenario === 'retry-success' && !resumed) {
    console.log(JSON.stringify({ type: 'turn.failed', message: 'First turn failed.' }));
    process.exit(1);
  }
  const result = {
    schemaVersion: 1,
    status: 'completed',
    summary: resumed ? 'Completed on the retry.' : 'Completed on the first turn.',
    completedItems: ['Fixture task'],
    incompleteItems: [],
    failureCategory: 'none',
    failureReason: null,
    retryRecommended: false,
    commitSha: null,
    pushed: false,
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result));
  console.log(
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: resumed ? 30 : 100, cached_input_tokens: 5, output_tokens: 20 },
    }),
  );
});

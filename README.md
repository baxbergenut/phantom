# Phantom

Phantom is a local, single-user dashboard for managing Codex tasks across local Git
repositories. Phase 6 adds quota-free local task classification, live Codex model
selection, and history-refined quota estimates on top of guarded direct Git pushes.

## Requirements

- Node.js 24 or newer
- npm 11 or newer
- Git available on `PATH`
- Codex CLI available on `PATH` and authenticated with `codex login`
- Ollama is optional but recommended for local classification; deterministic rules are
  always available when it is absent

## Run Phantom

```powershell
npm install
npm start
```

Open `http://127.0.0.1:4310`. `npm start` builds the application, applies pending
database migrations during startup, and serves the dashboard and API from one local
process.

For development with live reload, run `npm run dev`. This starts the Fastify API at
`http://127.0.0.1:4310` and the Vite dashboard at `http://127.0.0.1:4311`; Vite
proxies `/api` calls to Fastify.

The default SQLite database is `data/phantom.db`. The `data` directory and common
SQLite sidecar files are ignored by Git. To keep data elsewhere, copy `.env.example`
to `.env` or set `PHANTOM_DATABASE_PATH` in the shell before starting Phantom.

## Commands

| Command                | Purpose                                          |
| ---------------------- | ------------------------------------------------ |
| `npm start`            | Build and run the complete local application     |
| `npm run dev`          | Start API and dashboard live-reload servers      |
| `npm run db:migrate`   | Create or migrate the configured SQLite database |
| `npm run build`        | Build shared types, server, and dashboard        |
| `npm test`             | Run unit and API integration tests               |
| `npm run typecheck`    | Type-check all workspaces                        |
| `npm run lint`         | Run ESLint                                       |
| `npm run format:check` | Verify Prettier formatting                       |
| `npm run format`       | Apply Prettier formatting                        |

The checked-in `.env.example` documents available settings. This checkout also has an
ignored local `.env` configured for `127.0.0.1:4310` and `data/phantom.db`. Windows
service packaging remains intentionally deferred to Phase 8.

## Phase 6 behavior

- Project paths are resolved and validated with read-only Git commands.
- Tasks are created in `queued`, classified locally, and the scheduler runs one Codex
  task at a time.
- Queued tasks can be edited, reprioritized, or deleted.
- Failed or blocked tasks can be manually requeued.
- Queue order is urgent, high, normal, then low, with creation time breaking ties.
- The worker pause setting is durable and prevents new acquisitions without
  interrupting active work.
- Scheduler acquisition and task transition use one immediate SQLite transaction and
  a database-backed global lease.
- Every task transition and execution attempt is persisted. Stale or gracefully
  interrupted executions resume with the same execution ID, attempt number, and Codex
  thread.
- Worker health, current work, next eligible work, and task history are available in
  both the API and dashboard.
- Startup verifies the Codex executable, version output, authentication, JSONL events,
  output-schema support, and final-message support before accepting work.
- Before Codex starts, Phantom requires a Git repository, clean worktree, configured
  branch, present/reachable remote, and compatible local/remote history. Behind
  branches synchronize by fast-forward only; unsafe states become `blocked` without
  stashing, resetting, or discarding work.
- Codex runs with the task's selected model/reasoning settings, `danger-full-access`, and no
  interactive approvals. This is the minimum CLI sandbox that permits `.git` writes
  and authenticated pushes, so enabled projects are intentionally high trust.
- Codex must commit meaningful changes with an informative task-related message and
  push normally to the configured branch. It is explicitly forbidden to force-push.
- Phantom fetches after completion and independently verifies the claimed commit is
  local HEAD and reachable from the configured remote branch. It records starting and
  ending local/remote SHAs, changed files, and commit metadata.
- A valid no-change task completes without an empty commit only when its result
  explains why no commit was required. A rejected/unverified push receives the one
  allowed same-thread retry with the exact failure context.
- Executions store the Codex thread ID, concise live events, aggregate per-turn token
  usage, and a validated versioned final result. Invalid or missing structured output
  fails the attempt.
- Phantom initializes a narrow Codex App Server client, correlates JSON-RPC requests,
  consumes sparse quota notifications, reconnects once after transport failures, and
  closes the child process cleanly.
- Every dispatch requires a fresh `account/rateLimits/read`. If the read fails, data is
  stale, or a required short/weekly window is missing, the task remains
  `waiting_quota` and no execution attempt is consumed.
- All returned quota buckets are persisted. Windows are identified from their duration
  rather than `primary`/`secondary` position and the dashboard shows consumption,
  remaining percentage, resets, and freshness.
- Before quota is read or an execution is created, queued tasks move through a local
  `classifying` stage. The prompt contains only task text, project name, and target
  branch; it does not read repository files, paths, environment variables, or stored
  secrets.
- Ollama uses a versioned JSON schema with temperature zero. The default
  `qwen2.5-coder:3b` tag is a 3.09B Q4_K_M model whose Ollama artifact is about 1.9 GB,
  making it suitable for CPU inference on the target 16 GB Windows PC. Install Ollama,
  then run `ollama pull qwen2.5-coder:3b`; no GPU acceleration is assumed.
- Deterministic scoring covers prompt size, structured acceptance items, tests,
  migrations, authentication/security, deployment, broad refactors, destructive
  operations, and dependency upgrades. These rules can only raise local-model risk,
  complexity, tier, runtime, and quota classifications.
- Ollama connection failures, timeouts, missing models, invalid responses, and malformed
  JSON fall back to deterministic classification without consuming Codex quota. Startup
  and `GET /api/classifier/health` report service/model health without preventing the
  worker from starting.
- Four configurable Codex tiers map economy to Luna, standard to Terra, advanced to
  Sol, and premium to Astra by default. Immediately before dispatch, Phantom reads the
  live Codex model catalog and validates both model and reasoning effort. Fallbacks move
  only to an available equal-or-higher tier; safety tiers are never silently downgraded.
- Classification, selected tier/model/reasoning, fallback decisions, rationale, and
  quota estimate provenance are persisted on both the task and its execution and shown
  in the dashboard.
- Dispatch reserves 15% of the five-hour window and 10% of the weekly window by
  default. Baseline estimates use the classified quota class. After five completed
  executions for the same Codex model and complexity, Phantom uses the 75th percentile
  of observed short-window deltas, bounded to 50–150% of baseline and at most 80%.
- Normal failure receives at most one retry in the same Codex thread. A quota
  interruption persists its reset time, releases the worker lease, and resumes the
  original execution and Codex thread after reset without consuming that retry.
- Executions retain before/after quota snapshots and per-window usage deltas, including
  each segment around a quota pause. Reset timers are reconstructed from SQLite after
  restart.
- Active work can be cancelled from the dashboard. Timeout and cancellation terminate
  the child process and are stored as distinct failure categories before the scheduler
  releases its global lease.
- Full redacted JSONL logs live beside the database under `execution-logs`, separate
  from concise database events. Logs older than 14 days are pruned, with at most 100
  execution log pairs retained.
- The backend and dashboard bind to loopback by default.

The scheduler polls every 60 seconds. The optional environment settings
`PHANTOM_SCHEDULER_INTERVAL_MS`, `PHANTOM_HEARTBEAT_INTERVAL_MS`,
`PHANTOM_STALE_EXECUTION_MS`, and `PHANTOM_LEASE_DURATION_MS` override its timing.
`PHANTOM_CODEX_EXECUTABLE` and `PHANTOM_CODEX_TIMEOUT_MS` configure Codex process
execution. `PHANTOM_CODEX_MODEL` and `PHANTOM_CODEX_REASONING` remain fallback defaults
for legacy/unclassified calls; Phase 6 executions use the selected task settings.

`PHANTOM_OLLAMA_ENDPOINT`, `PHANTOM_OLLAMA_MODEL`, timeout, health-timeout,
keep-alive, and `PHANTOM_OLLAMA_NUM_GPU` settings configure local classification. The
GPU count defaults to zero so CPU-only operation is the tested baseline. `PHANTOM_MODEL_ECONOMY`,
`PHANTOM_MODEL_STANDARD`, `PHANTOM_MODEL_ADVANCED`, and `PHANTOM_MODEL_PREMIUM`, plus
their `_REASONING` companions, configure Codex tier mappings without code changes.

The target PC check on September 10, 2026 found 15.7 GB physical RAM. Ollama 0.34.0
and `qwen2.5-coder:3b` were installed for verification: the health request took 39 ms
and a schema-valid classification took 21.0 seconds with a 4,096-token context. `ollama
ps` reported 100% CPU and a 2.2 GB loaded footprint. This once-per-task latency is
acceptable for the one-at-a-time background queue, while the 60-second timeout still
provides a deterministic fallback for slower machines.

Quota defaults are a 10-second App Server request timeout, 30-second freshness limit,
30-second post-reset safety delay, and 60-second provider retry. The
`PHANTOM_QUOTA_*` entries in `.env.example` configure those values, short/weekly
reserves, and the small/medium/large/very-large estimates used by the scheduler.

The full roadmap and locked safety decisions are in
[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md).

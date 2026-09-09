# Phantom

Phantom is a local, single-user dashboard for managing Codex tasks across local Git
repositories. Phase 4 adds guarded Git synchronization, Codex commits and direct
pushes, and independent verification that completed work reached the configured branch.

## Requirements

- Node.js 24 or newer
- npm 11 or newer
- Git available on `PATH`
- Codex CLI available on `PATH` and authenticated with `codex login`

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

## Phase 4 behavior

- Project paths are resolved and validated with read-only Git commands.
- Tasks are created in `queued` and the scheduler runs one task at a time.
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
- Codex runs with explicit model/reasoning settings, `danger-full-access`, and no
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
- Normal failure receives at most one retry in the same Codex thread. Rate limits enter
  `waiting_quota`; reset-aware wakeup arrives in Phase 5.
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
`PHANTOM_CODEX_EXECUTABLE`, `PHANTOM_CODEX_MODEL`, `PHANTOM_CODEX_REASONING`, and
`PHANTOM_CODEX_TIMEOUT_MS` configure Codex; defaults are `codex`, `gpt-5.6-sol`,
`high`, and one hour.

The full roadmap and locked safety decisions are in
[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md).

# Phantom

Phantom is a local, single-user dashboard for managing Codex tasks across local Git
repositories. Phase 1 provides durable project and task management only; it does not
run Codex or change registered repositories.

## Requirements

- Node.js 24 or newer
- npm 11 or newer
- Git available on `PATH`

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

## Phase 1 behavior

- Project paths are resolved and validated with read-only Git commands.
- Tasks are always created in `queued`; Phase 1 has no route that starts a task.
- Queued tasks can be edited, reprioritized, or deleted.
- Failed or blocked tasks can be manually requeued.
- Queue order is urgent, high, normal, then low, with creation time breaking ties.
- The worker pause setting is durable, though there is no worker yet.
- The backend and dashboard bind to loopback by default.

The full roadmap and locked safety decisions are in
[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md).

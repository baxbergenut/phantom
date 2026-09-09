# Phantom

Phantom is a local, single-user dashboard for managing Codex tasks across local Git
repositories. Phase 1 provides durable project and task management only; it does not
run Codex or change registered repositories.

## Requirements

- Node.js 24 or newer
- npm 11 or newer
- Git available on `PATH`

## Development

```powershell
npm install
npm run db:migrate
npm run dev
```

One command, `npm run dev`, starts the Fastify API at
`http://127.0.0.1:4310` and the Vite dashboard at
`http://127.0.0.1:4311`. Vite proxies `/api` calls to Fastify.

The default SQLite database is `data/phantom.db`. The `data` directory and common
SQLite sidecar files are ignored by Git. To keep data elsewhere, copy `.env.example`
to `.env` or set `PHANTOM_DATABASE_PATH` in the shell before starting Phantom.

## Commands

| Command                | Purpose                                          |
| ---------------------- | ------------------------------------------------ |
| `npm run dev`          | Start API and dashboard development servers      |
| `npm run db:migrate`   | Create or migrate the configured SQLite database |
| `npm run build`        | Build shared types, server, and dashboard        |
| `npm run start`        | Start the built API server                       |
| `npm test`             | Run unit and API integration tests               |
| `npm run typecheck`    | Type-check all workspaces                        |
| `npm run lint`         | Run ESLint                                       |
| `npm run format:check` | Verify Prettier formatting                       |
| `npm run format`       | Apply Prettier formatting                        |

For a production-style run, use `npm run build` followed by `npm start`. Serving the
built dashboard from Fastify and Windows service packaging are intentionally deferred
to Phase 8. You can preview the dashboard build with
`npm run preview -w @phantom/dashboard`.

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

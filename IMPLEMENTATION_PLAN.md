# Phantom — Codex Project Manager Implementation Plan

This document is the source of truth for building Phantom. Phantom is a local,
single-user application that continuously processes a dashboard-managed queue of
Codex tasks, one at a time, against local Git repositories backed by GitHub.

## How to use this plan across Codex tasks

Each implementation phase should be completed in a separate Codex task to keep
the working context small.

At the start of a phase:

1. Read this entire file.
2. Confirm all prerequisite phases are marked complete.
3. Work only on the selected phase unless a prerequisite requires a small repair.
4. Preserve decisions and interfaces established by completed phases.

At the end of a phase:

1. Run every verification listed under that phase.
2. Check off the phase and its completed checklist items only when the acceptance
   criteria actually pass.
3. Add an entry to the Phase Completion Log with the date, commit SHA, tests run,
   and any important decisions or known limitations.
4. Update the Current Handoff Snapshot so the next Codex task does not have to
   reconstruct project state from Git history.
5. Commit and push the finished phase to `origin/main`.

Suggested prompt for a new Codex task:

> Read IMPLEMENTATION_PLAN.md completely. Implement Phase N only. Follow its
> scope, safeguards, acceptance criteria, and verification steps. When finished,
> update the phase checklist, Phase Completion Log, and Current Handoff Snapshot,
> then commit and push the work to origin/main. Do not begin a later phase.

## Locked product decisions

- Phantom runs continuously on one Windows PC.
- It is a personal, single-user application.
- The dashboard is available only on localhost by default.
- Tasks are created and edited through the dashboard.
- Projects are local Git repositories with GitHub remotes.
- Exactly one task may run at a time across all projects.
- Tasks are ordered by priority and then creation time.
- Codex works on the configured main branch, which defaults to `main`.
- Successful changes are committed and pushed directly to `origin/main`.
- Phantom never opens pull requests and never force-pushes.
- There is no human approval step before a task runs or is pushed.
- A task is complete when Codex reports completion and any required Git push is
  confirmed on the remote.
- A normal failure is retried once in the same Codex thread.
- A quota interruption waits for reset and resumes the same thread; it does not
  consume the normal retry.
- Telegram is used for short reports, not for creating tasks in the first version.
- The first version does not support dependencies between tasks.
- A free local model running through Ollama classifies tasks. Deterministic rules
  remain available as a fallback and may override unsafe classifications.

## Global safety invariants

These requirements apply to every phase and must not be weakened silently:

- Never run more than one Codex task concurrently.
- Never force-push, hard-reset, or discard uncommitted user changes.
- Before a run, require a clean working tree and the configured branch checked out.
- Synchronize with the remote using fast-forward-only behavior.
- If local and remote history diverge, block the task and notify the user.
- Store the starting commit, ending commit, Codex thread ID, and execution attempt.
- Confirm a claimed pushed commit exists on the configured remote branch.
- Bind the web server to loopback unless the user explicitly changes it.
- Do not store authentication tokens, Telegram tokens, or Codex credentials in Git.
- Design every long-running operation to survive or recover from a process restart.
- Keep logs useful while redacting credentials and other known secrets.

## Planned architecture

- **Language:** TypeScript
- **Dashboard:** React and Vite
- **Backend:** Fastify
- **Database:** SQLite with Drizzle ORM
- **Worker:** Persistent Node.js process sharing the backend's database
- **Codex integration:** Codex SDK or non-interactive Codex execution with JSONL
  events and JSON Schema output
- **Quota integration:** Codex App Server `account/rateLimits/read` and rate-limit
  update events
- **Local classifier:** Ollama with a small quantized 3–4B instruction/coding model
- **Telegram:** Bot API long polling
- **Deployment:** Local Windows service plus localhost dashboard

The exact packages may be adjusted during Phase 1, but changes to the component
boundaries or locked decisions must be recorded in this file.

## Phase status

- [x] Bootstrap prerequisite — Phantom is initialized on `main`, with
  `https://github.com/baxbergenut/phantom.git` configured as `origin`.
- [ ] Phase 1 — Foundation, database, projects, and task board
- [ ] Phase 2 — Persistent single-task scheduler and restart recovery
- [ ] Phase 3 — Codex execution, structured results, and same-thread retries
- [ ] Phase 4 — Git synchronization, commit verification, and direct push
- [ ] Phase 5 — Live quota integration and reset-aware scheduling
- [ ] Phase 6 — Local complexity classifier and model selection policy
- [ ] Phase 7 — Telegram reporting
- [ ] Phase 8 — Windows service packaging, hardening, and release readiness

---

## Phase 1 — Foundation, database, projects, and task board

**Status:** Planned

### Objective

Create a runnable local application with a durable database and a dashboard for
managing projects and tasks. No Codex task should be launched in this phase.

### Required work

- [ ] Establish the TypeScript project structure for the backend, dashboard, and
  shared types. Prefer a small workspace/monorepo layout without unnecessary
  infrastructure.
- [ ] Add development, build, type-check, lint, test, database migration, and
  production-start commands.
- [ ] Configure Fastify and serve health/version endpoints.
- [ ] Configure React/Vite and provide a usable localhost dashboard shell.
- [ ] Configure SQLite and Drizzle migrations. The database file must live outside
  tracked source files and must not be committed.
- [ ] Create a `projects` model containing at least: ID, name, local path, remote
  name, remote branch, enabled state, timestamps, and optional validation commands.
- [ ] Create a `tasks` model containing at least: ID, project ID, title,
  instructions, priority, status, timestamps, attempt count, and status reason.
- [ ] Define task statuses centrally: `queued`, `classifying`, `waiting_quota`,
  `running`, `retrying`, `completed`, `failed`, and `blocked`.
- [ ] Add API validation and shared request/response types.
- [ ] Implement project create, list, edit, enable/disable, and delete operations.
- [ ] Validate that a project path exists and appears to be a Git repository. Do
  not modify the repository during validation.
- [ ] Implement task create, list, view, edit, reprioritize, cancel/delete while
  queued, and manually requeue failed/blocked tasks.
- [ ] Implement priority ordering: urgent, high, normal, low; ties use creation time.
- [ ] Build dashboard views for the project list, project editor, Kanban-style task
  board, task form, and task details.
- [ ] Add a global worker pause/resume setting even though the worker is not active
  yet. Store it durably in the database.
- [ ] Add clear empty, loading, validation-error, and backend-offline UI states.
- [ ] Add a `.env.example` containing names only, never real credentials.
- [ ] Write initial developer setup and run instructions in the project README.

### Acceptance criteria

- The app starts locally with one documented command for development.
- Database migrations create a fresh database successfully.
- A user can register a local Git project and create, edit, order, and requeue tasks.
- Refreshing or restarting the app preserves all records.
- Invalid project paths and invalid task submissions produce helpful errors.
- No task can accidentally transition to `running` in this phase.

### Verification

- Run formatting/linting, type-checking, unit tests, and a production build.
- Exercise the core project and task API routes with integration tests.
- Manually create a temporary example project and tasks through the dashboard.
- Restart the backend and confirm persisted data remains visible.

---

## Phase 2 — Persistent single-task scheduler and restart recovery

**Status:** Planned

**Prerequisite:** Phase 1

### Objective

Create the durable orchestration engine that selects and leases one task at a time.
Use a fake executor in this phase so scheduling can be tested without consuming
Codex quota or modifying repositories.

### Required work

- [ ] Add an `executions` model for task runs, including task ID, attempt number,
  lifecycle state, timestamps, worker identity, heartbeat, and recovery metadata.
- [ ] Add a durable event/history model so every task status transition has a
  timestamp, previous state, new state, and reason.
- [ ] Implement a scheduler tick, defaulting to every 60 seconds and configurable.
- [ ] Select only enabled projects and queued tasks, ordered by priority and creation
  time.
- [ ] Enforce a database-backed global lease so no second worker or duplicate timer
  can start another task.
- [ ] Make acquisition and task transition atomic in SQLite.
- [ ] Respect the durable global pause flag.
- [ ] Add graceful shutdown behavior that stops taking work and records the state of
  any active execution.
- [ ] Add worker heartbeats and stale-execution detection.
- [ ] Define restart recovery rules. A stale fake execution should be recovered or
  returned to a resumable state without creating a duplicate attempt.
- [ ] Add a fake executor capable of success, delay, failure, and simulated crash so
  scheduler behavior can be tested deterministically.
- [ ] Expose worker health, last poll time, current task, next eligible task, and
  pause state through the API and dashboard.
- [ ] Make task state transitions explicit and reject invalid transitions.
- [ ] Record structured application logs with correlation IDs for task and execution.

### Acceptance criteria

- Even with overlapping timer ticks, only one fake task runs at a time.
- Tasks run in the documented priority/FIFO order.
- Pausing prevents new work but does not corrupt the current execution.
- A simulated worker crash can be recovered after restart without duplicate runs.
- Every status change is visible in task history.
- Scheduler tests do not require Codex, GitHub, Ollama, or Telegram.

### Verification

- Run unit tests for task ordering and state transition rules.
- Run concurrency tests with overlapping scheduler ticks.
- Run integration tests for pause/resume and stale-lease recovery.
- Simulate a process restart during a fake task and confirm deterministic recovery.

---

## Phase 3 — Codex execution, structured results, and same-thread retries

**Status:** Planned

**Prerequisite:** Phase 2

### Objective

Replace the fake executor with Codex while preserving the scheduler contract. Capture
machine-readable progress and require a structured final answer.

### Required work

- [ ] Choose and document whether the first implementation uses the Codex SDK or
  `codex exec`. Keep the integration behind an adapter interface.
- [ ] Add a startup capability check for the installed Codex version, authentication,
  executable availability, and required output features.
- [ ] Launch Codex in the configured project's local directory with explicit model,
  reasoning, sandbox, and approval settings.
- [ ] Use the minimum permissions that still allow the agreed fully autonomous task
  workflow. Do not introduce forceful Git behavior.
- [ ] Capture the Codex thread ID immediately and persist it on the execution.
- [ ] Consume JSONL/streamed events and store useful progress, command, file-change,
  usage, failure, and final-message information.
- [ ] Prevent unbounded database growth by separating concise persisted events from
  full raw logs and defining log retention.
- [ ] Define and version a JSON Schema for the final Codex response. It must include:
  status, summary, completed items, incomplete items, failure category, failure
  reason, retry recommendation, commit SHA when applicable, and pushed state.
- [ ] Treat malformed or missing structured output as a failed attempt, not success.
- [ ] Add timeout and cancellation behavior. Cancellation must terminate the child
  execution without starting another task early.
- [ ] Implement one normal retry by resuming the same Codex thread with the original
  failure context.
- [ ] Distinguish normal failures from rate-limit failures. At this phase, rate-limit
  failures may enter `waiting_quota`; Phase 5 will implement reset-aware wakeup.
- [ ] Store per-turn token usage supplied by Codex events.
- [ ] Display live activity and the final structured result in the dashboard.
- [ ] Ensure logs and error payloads redact known authentication values.

### Acceptance criteria

- A test task can be started by the scheduler and produces a stored Codex thread ID.
- Progress appears in the dashboard while the task runs.
- A valid completion, failure, timeout, cancellation, and malformed output are each
  handled distinctly.
- A normal retry resumes the original thread and occurs at most once.
- The scheduler does not start another task until the Codex process and cleanup have
  fully finished.
- Codex is not yet permitted to push as part of acceptance testing; Phase 4 owns that
  workflow.

### Verification

- Unit-test the event parser and structured-result validator with recorded fixtures.
- Integration-test success, failure, cancellation, timeout, and retry behavior.
- Run one harmless real Codex task in a disposable Git repository.
- Confirm secrets do not appear in stored events or application logs.

---

## Phase 4 — Git synchronization, commit verification, and direct push

**Status:** Planned

**Prerequisite:** Phase 3

### Objective

Allow Codex to work directly on a project's configured main branch and push completed
work to GitHub, while refusing unsafe repository states.

### Required work

- [ ] Implement a Git adapter using argument arrays rather than shell-built command
  strings.
- [ ] Resolve and validate the configured repository path before every operation.
- [ ] Add preflight checks for: Git repository, clean working tree, configured branch
  checked out, configured remote present, and reachable remote.
- [ ] Fetch the remote and require local HEAD to be compatible with the remote branch.
- [ ] Synchronize before execution using fast-forward-only behavior.
- [ ] If the working tree is dirty, the branch is wrong, or history has diverged,
  move the task to `blocked` with a precise reason. Never discard or stash changes
  automatically.
- [ ] Persist starting HEAD, starting remote SHA, ending HEAD, and ending remote SHA.
- [ ] Add explicit Git instructions to the Codex task contract: implement the task,
  commit meaningful changes, and push to the configured branch without force.
- [ ] Ensure Codex uses an informative commit message related to the task.
- [ ] Handle tasks that correctly produce no changes; require Codex to say why no
  commit was necessary.
- [ ] After Codex reports completion, fetch the remote and independently verify that
  the claimed commit is reachable from the configured remote branch.
- [ ] A completion that required changes must not be marked complete until remote
  verification succeeds.
- [ ] If push is rejected because the remote advanced, resume the same Codex thread
  once with the exact Git failure. Never automatically force-push.
- [ ] Record changed-file summaries and commit metadata for reports.
- [ ] Add prominent dashboard warnings explaining that enabled projects allow direct
  automated pushes to the configured branch.

### Acceptance criteria

- A successful task creates a commit on the configured branch and that commit is
  independently confirmed on the GitHub remote.
- A no-change task can complete without manufacturing an empty commit.
- Dirty, wrong-branch, missing-remote, unreachable-remote, and diverged states block
  safely without modifying local work.
- Push rejection follows the single-retry policy and never invokes a force push.
- Git metadata and failure reasons are visible in the task report.

### Verification

- Use disposable local and bare remote repositories for automated Git tests.
- Test clean success, no changes, dirty tree, wrong branch, divergence, and rejected
  push scenarios.
- Perform one controlled end-to-end push to a dedicated test GitHub repository.
- Search the codebase and logs to confirm no force-push path exists.

---

## Phase 5 — Live quota integration and reset-aware scheduling

**Status:** Planned

**Prerequisite:** Phase 4

### Objective

Read the signed-in Codex account's live quota windows, prevent unsafe dispatch, and
resume quota-interrupted tasks after the relevant reset.

### Required work

- [ ] Add a narrow Codex App Server client behind a quota-provider interface.
- [ ] Implement initialization, request IDs, response correlation, reconnects,
  timeouts, and clean shutdown.
- [ ] Read `account/rateLimits/read` and consume rate-limit update notifications.
- [ ] Support multiple returned buckets rather than assuming array order or a fixed
  number of limits.
- [ ] Store snapshots containing limit ID, used percentage, window duration, reset
  timestamp, plan type when supplied, and observation time.
- [ ] Identify the active short and weekly windows by duration/metadata rather than
  blindly labeling primary and secondary fields.
- [ ] Display current consumption, remaining percentage, reset times, and snapshot
  freshness in the dashboard.
- [ ] Take a fresh quota snapshot immediately before dispatch and after every attempt.
- [ ] If a fresh snapshot cannot be obtained, do not start a new task. Mark it waiting
  with a clear degraded-service reason.
- [ ] Implement configurable reserves, initially 15% for the five-hour window and 10%
  for the weekly window.
- [ ] Add initial usage estimates by complexity class: small 10%, medium 20%, large
  35%, very large 50% of usable short-window capacity. Keep these configurable.
- [ ] Gate dispatch using remaining quota, configured reserves, and the task estimate.
- [ ] When Codex or the quota provider reports exhaustion, enter `waiting_quota`,
  store the reset timestamp, and schedule wakeup with a small safety delay.
- [ ] On reset, refresh limits and resume the same Codex thread. Do not increment the
  normal retry count for quota waits.
- [ ] Record before/after quota deltas for each execution and prepare the history that
  Phase 6 will use for improved estimates.
- [ ] Recover reset timers correctly after application or PC restart.

### Acceptance criteria

- Phantom does not dispatch when a fresh quota check fails or reserves would be
  violated.
- Both short and weekly limits are enforced.
- A quota-interrupted execution waits until reset and resumes the original thread.
- Restarting Phantom while waiting does not lose or duplicate the scheduled resume.
- Before/after usage appears in task history.

### Verification

- Unit-test bucket interpretation, reserve calculations, reset times, and clock edge
  cases with fixtures.
- Integration-test App Server reconnects and stale snapshot behavior using a fake
  protocol server.
- Simulate short-window and weekly exhaustion without consuming real quota.
- Perform one read-only live quota check against the signed-in Codex installation.

---

## Phase 6 — Local complexity classifier and model selection policy

**Status:** Planned

**Prerequisite:** Phase 5

### Objective

Classify queued tasks without spending Codex quota, choose an appropriate configurable
Codex model tier, and improve usage estimates using execution history.

### Required work

- [ ] Add Ollama connection settings and a startup/health check.
- [ ] Select and document a small quantized 3–4B model suitable for CPU inference on
  a Windows PC with 16 GB RAM and approximately 500 MB dedicated GPU memory.
- [ ] Keep the Ollama model configurable and do not assume GPU acceleration.
- [ ] Define a versioned structured classification schema containing: complexity,
  risk, confidence, rationale, model tier, reasoning level, estimated runtime class,
  estimated quota class, and human-attention flags.
- [ ] Build the classifier prompt from task text and minimal project metadata. Do not
  expose stored secrets or unrelated repository content.
- [ ] Add deterministic scoring for task size, keywords, acceptance criteria, and
  risky categories such as migrations, authentication, deployment, broad refactors,
  destructive operations, and dependency upgrades.
- [ ] Let deterministic safety rules increase risk/tier even when the local model
  recommends a lower level.
- [ ] Implement a deterministic-only fallback when Ollama is missing, slow, invalid,
  or returns malformed output.
- [ ] Define configurable model tiers rather than hardcoding product assumptions:
  economy, standard, advanced, and premium.
- [ ] Map each tier to a Codex model and reasoning effort in settings. Validate model
  availability before dispatch and define a fallback order.
- [ ] Persist the chosen model, reasoning effort, rationale, classifier version, and
  whether fallback logic was used.
- [ ] Use historical before/after quota deltas grouped by model and complexity to
  refine initial estimates conservatively once sufficient samples exist.
- [ ] Prevent one unusual task from radically changing estimates; use minimum sample
  counts, bounds, and conservative percentiles.
- [ ] Display the classification and model-selection explanation in the dashboard.

### Acceptance criteria

- Classification does not consume Codex quota.
- Every queued task receives a valid tier and quota estimate, even if Ollama is down.
- Risk overrides behave deterministically and are covered by tests.
- Model names and reasoning effort can be changed without code changes.
- Historical estimates are explainable and fall back safely when data is sparse.

### Verification

- Build a fixture set of small, medium, large, very large, and high-risk task texts.
- Test local-model success, timeout, unavailable service, and malformed output.
- Test deterministic overrides and model fallback ordering.
- Verify CPU inference is acceptable on the target PC and document observed latency.

---

## Phase 7 — Telegram reporting

**Status:** Planned

**Prerequisite:** Phase 6

### Objective

Send concise task, failure, blocked, and quota notifications to the owner's Telegram
chat using outbound long polling, without exposing the dashboard publicly.

### Required work

- [ ] Integrate a maintained Telegram Bot API library using long polling.
- [ ] Store the bot token outside Git. Prefer an OS-backed secret mechanism when
  practical, with an environment-variable fallback documented for development.
- [ ] Add a setup flow that validates the bot token and captures/authorizes exactly
  one Telegram chat ID.
- [ ] Ignore commands and messages from unauthorized chat IDs.
- [ ] Send completion reports containing project, task, selected model tier, duration,
  attempt count, concise summary, commit SHA or no-change explanation, push status,
  and before/after quota percentages.
- [ ] Send failure reports containing category, attempts, useful reason, and whether
  the task can be manually requeued.
- [ ] Send blocked reports for unsafe Git state, authentication problems, unavailable
  Codex, missing fresh quota data, and other user-action conditions.
- [ ] Send a quota-wait notification when a task first pauses, including the expected
  reset time. Avoid repeated unchanged notifications.
- [ ] Send a recovery notification when work resumes after a quota reset.
- [ ] Escape or format arbitrary Codex/task text safely for Telegram.
- [ ] Implement delivery retries with backoff and idempotency/deduplication so a
  restart does not spam duplicate reports.
- [ ] Persist notification status and delivery errors without failing the underlying
  completed task solely because Telegram is unavailable.
- [ ] Add optional read-only `/status` and `/queue` commands if they fit cleanly. Task
  creation through Telegram remains out of scope.
- [ ] Add dashboard settings and a test-notification action.

### Acceptance criteria

- The authorized chat receives one concise report for each meaningful event.
- Unauthorized chats cannot inspect or control Phantom.
- Telegram downtime does not block the task scheduler or alter task outcomes.
- Restarting after a sent notification does not resend it.
- No inbound port or public dashboard is required.

### Verification

- Unit-test report rendering, text escaping, authorization, and deduplication.
- Integration-test transient Telegram failures using a fake API.
- Send test success, failure, blocked, and quota-wait messages to the real authorized
  chat.
- Confirm the bot token never appears in Git, dashboard responses, or logs.

---

## Phase 8 — Windows service packaging, hardening, and release readiness

**Status:** Planned

**Prerequisite:** Phase 7

### Objective

Package Phantom as a reliable always-on local application, verify end-to-end recovery,
and make normal installation, upgrading, backup, and troubleshooting manageable.

### Required work

- [ ] Produce deterministic production builds for backend, worker, and dashboard.
- [ ] Choose and document a Windows service strategy that starts after login/boot,
  restarts on crashes, uses a stable working directory, and runs without a visible
  terminal window.
- [ ] Serve the production dashboard from the local backend and bind to loopback by
  default.
- [ ] Add first-run setup for database location, Codex health/authentication, project
  registration, model tiers, Ollama, and Telegram.
- [ ] Add readiness and health checks for the database, scheduler, Codex, App Server,
  Ollama, Git, GitHub connectivity, and Telegram.
- [ ] Implement controlled database migrations with a documented backup step.
- [ ] Document backup and restore for the SQLite database and configuration, excluding
  secrets unless the chosen secret store has its own recovery procedure.
- [ ] Add log rotation, retention limits, and an exportable diagnostic bundle that
  redacts secrets.
- [ ] Add graceful update/shutdown behavior so an active Codex task is not duplicated.
- [ ] Verify recovery after process crash, service restart, PC reboot, network loss,
  GitHub outage, Ollama outage, App Server reconnect, and quota reset.
- [ ] Review all process spawning, path handling, and Git arguments for injection and
  Windows quoting problems.
- [ ] Verify localhost access controls and protect state-changing endpoints against
  cross-site request attacks from arbitrary browser pages.
- [ ] Add database indexes and retention/cleanup policies for long-running use.
- [ ] Add an operator guide covering install, start/stop, upgrades, common blocked
  states, manual requeue, credential renewal, and uninstall.
- [ ] Run a full end-to-end test: create a dashboard task, classify it, pass quota
  gating, execute Codex, commit, push, mark complete, and receive a Telegram report.

### Acceptance criteria

- Phantom starts automatically and recovers after a normal Windows reboot.
- The dashboard remains localhost-only by default.
- A crash or restart cannot cause two tasks to run or the same task to push twice.
- Installation, backup, restore, update, troubleshooting, and uninstall are documented.
- The complete real workflow succeeds against a dedicated test repository.
- All automated tests, production builds, and security-focused checks pass.

### Verification

- Test installation and first-run setup on the target PC.
- Reboot Windows during safe points and simulate termination during a task.
- Run the complete automated test suite and production build from a clean checkout.
- Complete the real end-to-end test and retain its report as release evidence.
- Review tracked files and built artifacts for accidentally included credentials.

---

## Current Handoff Snapshot

Update this section at the end of every phase.

- **Current completed phase:** None
- **Bootstrap state:** Complete; local `main` tracks `origin/main` on GitHub
- **Next phase:** Phase 1 — Foundation, database, projects, and task board
- **Last known good commit:** `4cf8691` (initial implementation plan; a later
  bookkeeping commit records bootstrap completion)
- **How to run:** Not yet implemented
- **How to test:** Not yet implemented
- **Database/schema version:** Not yet implemented
- **Important active decisions:** See Locked product decisions above
- **Known issues or limitations:** Implementation has not started

## Phase Completion Log

Add one entry per completed phase. Do not delete older entries.

### Entry template

```text
Phase:
Completed on:
Commit SHA:
Summary:
Verification performed:
Important decisions:
Known limitations / follow-up:
```

# Owner Task Control Node Implementation Plan

> **For agentic workers:** Execute inline in this worktree. Keep every production change behind a focused failing test and do not commit from this worker.

**Goal:** Add the default-off Node half of owner task status and confirmed Codex stop, with durable retry and replay-safe local effects.

**Architecture:** The CLI writes metadata-only request records. The daemon exchanges typed task-control events through `NodeClient`, persists registrations and results until receipt, and executes target operations through a local journal. Status derives from exact local task provenance and Codex process identity. Stop first resolves a fresh status, then submits the exact opaque run version; target execution rechecks current policy and stored local provenance.

**Tech Stack:** Node.js type-stripped TypeScript (`.mts`), built-in `node:test`, atomic JSON files, existing WebSocket daemon.

---

### Task 1: Policy and local storage

**Files:** `session-policy.mts`, `policy.mts`, `config.mts`, new `task-control-store.mts`, focused tests.

- [ ] Write failing tests for default-off `sessions.ownTaskControl`, capability advertisement, durable registrations/requests/results, interrupted execution recovery, and immutable replay.
- [ ] Run focused tests red.
- [ ] Add minimal policy, paths, and atomic record helpers; rerun green.

### Task 2: Status and Codex stop

**Files:** new `task-control-local.mts`, `codex-runner.mts`, `task-watch.mts`, focused tests.

- [ ] Write failing tests for metadata-only status, opaque run versions, unsupported Claude stop, missing identity, and exact local provenance.
- [ ] Add the three stop races: replacement task during delayed terminate, same PID with changed start, same run reported done during terminate.
- [ ] Run focused tests red.
- [ ] Implement journaled execution and post-terminate identity guards; merge same-run stop into the fresh record; rerun green.

### Task 3: Typed exchange and daemon wiring

**Files:** borrowed unchanged `protocol-task-control.mts`, `client.mts`, `daemon.mts`, new `task-control-exchange.mts`, focused tests.

- [ ] Write failing tests for registration/result retry until receipt, execute replay, current-policy recheck, and strict event parsing.
- [ ] Run focused tests red.
- [ ] Wire the typed events through the existing serialized daemon lane; rerun green.

### Task 4: CLI lifecycle

**Files:** new `task-control-cli.mts`, `task-cli.mts`, focused tests.

- [ ] Write failing tests for `task status <taskId|requestId|messageId>`, `task stop <taskId>`, and `task result <requestId>`.
- [ ] Test that timeout keeps the pending request ID and never claims cancellation.
- [ ] Implement file-backed requests and fresh-status-before-stop; rerun green.

### Task 5: #133 registration and verification

**Files:** borrowed #133 `inbox.mts`, `task-records.mts`, `delivery-identity.mts`, narrow registration wiring and tests.

- [ ] Write a failing registration test from exact `delivery.taskId/runtime/sessionId` and source message ID.
- [ ] Implement immutable registration creation and retry; rerun green.
- [ ] Run all changed Node tests and `npm run typecheck`.
- [ ] Inspect `git diff --check`, complete diff, and status for owned scope and metadata-only wire fields.

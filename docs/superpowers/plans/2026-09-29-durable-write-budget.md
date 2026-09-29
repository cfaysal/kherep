# Durable Write Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound Worker Durable Object writes by changing only session rows whose metadata changed and by ignoring duplicate sequenced frames for liveness writes while retaining their acknowledgements.

**Architecture:** Keep snapshot reconciliation inside the Registry's existing synchronous SQLite transaction. Normalize duplicate session IDs with last value wins, compare all stored nullable metadata, then insert, update, or delete one row at a time without dynamic placeholder lists. In NodeSession, process the cumulative acknowledgement before duplicate detection and record liveness only for new sequenced frames or nonsequenced control frames.

**Tech Stack:** TypeScript, Cloudflare Durable Objects SQLite, Vitest with workerd.

---

### Task 1: Lock the write budget with failing Workerd tests

**Files:**
- Create: `modules/control-plane/worker/test/session-write-budget.test.mts`

- [x] Add actual SQLite change-count assertions for unchanged and reordered snapshots, one changed state/title, nullable clearing, add/remove/empty, and duplicate IDs with last value wins.
- [x] Add a reconnect/duplicate-frame test proving a useful ack is processed while duplicate sequence input does not rewrite `lastSeen`.
- [x] Run the focused tests and retain the expected RED evidence outside the repository.

### Task 2: Differential session persistence and duplicate-frame liveness

**Files:**
- Modify: `modules/control-plane/worker/src/registry.mts`
- Modify: `modules/control-plane/worker/src/node-session.mts`

- [x] Reconcile normalized incoming sessions against stored rows within the existing atomic transaction.
- [x] Preserve `updated_at` for unchanged metadata and set it only for inserted or changed rows.
- [x] Move `lastSeen` persistence after duplicate sequence detection while keeping ack processing first and nonsequenced activity unchanged.
- [x] Run focused tests to GREEN and record measured before/after write counts.

### Task 3: Verification and scope audit

**Files:**
- Review: the files above and the final diff.

- [x] Run Worker focused tests, Worker typecheck, Worker bundle dry run, root typecheck, and root bootstrap tests.
- [x] Store concise logs in an operator-local evidence directory outside the repository.
- [x] Confirm no protocol, policy, permission, privacy, deployment, or unrelated source change.

### Task 4: Resolve Claude delivery progress once per message

**Files:**
- Modify: `modules/control-plane/node/delivery-progress.mts`
- Modify: `modules/control-plane/node/delivery-progress.test.mts`
- Modify: `modules/control-plane/node/codex-sessions.mts`
- Modify: `modules/control-plane/node/codex-sessions.test.mts`
- Modify: `modules/control-plane/node/deliver-codex.test.mts`

- [x] Resolve accepted messages against the complete current snapshot by exact session id first, then by a unique current name.
- [x] Keep exact Codex ids authoritative and classify aliases shared across runtimes as ambiguous before the Codex queue can wake a target.
- [x] Emit one stable `ambiguous-target` observation for a shared name and preserve offered messages as `awaiting-turn-confirmation`.
- [x] Cover reversed snapshot order, repeated ticks, ambiguity resolution, covering receipts, id/name collisions, and Claude/Codex collisions.
- [x] Run the focused progress suite and the root control-plane suite.

### Task 5: End a superseded daemon connection

**Files:**
- Modify: `modules/control-plane/node/daemon.mts`
- Create: `modules/control-plane/node/daemon-close.test.mts`
- Modify: `modules/control-plane/ARCHITECTURE.md`
- Modify: `modules/control-plane/README.md`

- [x] Treat Worker close code 4409 as a terminal handoff after clearing connection timers.
- [x] Preserve terminal 4403 handling and retry transient closes with the existing backoff.
- [x] Drive the real daemon close handler with a synthetic WebSocket and retain RED/GREEN evidence outside the repository.
- [x] Run the focused daemon tests, root typecheck, and final diff audit.

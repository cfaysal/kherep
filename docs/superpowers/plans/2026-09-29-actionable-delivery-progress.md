# Actionable Intercom Delivery Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Give senders fixed, metadata-only explanations while an accepted message waits for delivery.

**Architecture:** Add optional strict progress to the existing authenticated status and receipt protocol. Persist it monotonically in the Worker and local exchange, then produce it from the existing Claude, Codex, and closed-session decision points without adding wake attempts.

**Tech Stack:** Node.js `.mts`, Cloudflare Durable Objects SQLite, Node test runner, Vitest.

---

### Task 1: Define the strict protocol

**Files:**
- Modify: `modules/control-plane/protocol-messages.mts`
- Test: `modules/control-plane/protocol-messages.test.mts`

- [x] Add failing tests that accept only fixed phase/code pairs, valid ordered timestamps, and progress on `accepted`; reject extra properties, task IDs, text, paths, raw errors, invalid pairs, and progress on final states.
- [x] Run `node --test modules/control-plane/protocol-messages.test.mts` and confirm the new assertions fail because progress is not defined.
- [x] Add `MessageProgress`, fixed constants, strict validators, and optional `storedProgressAt` on receipts.
- [x] Re-run the protocol test and confirm it passes.

### Task 2: Persist authenticated same-state progress in the Worker

**Files:**
- Modify: `modules/control-plane/worker/src/message-store.mts`
- Test: `modules/control-plane/worker/test/messaging.test.mts`

- [x] Add failing tests for authenticated same-state relay, strict foreign-report rejection, newer ordering, stale and duplicate suppression, reconnect replay, and delivered/replied precedence.
- [ ] Focused Worker red run was not captured before implementation; the added same-state assertions are verified green below.
- [x] Add additive progress columns, canonical status projection, same-state update logic, receipt correlation, and clearing on forward state changes.
- [x] Re-run the focused Worker test and confirm it passes.

### Task 3: Make node progress durable and retry-safe

**Files:**
- Modify: `modules/control-plane/node/inbox.mts`
- Modify: `modules/control-plane/node/client.mts`
- Modify: `modules/control-plane/node/exchange.mts`
- Test: `modules/control-plane/node/exchange.test.mts`
- Test: `modules/control-plane/node/client.test.mts`

- [x] Add failing tests for same-state sender updates, local stale suppression, progress receipts, socket enqueue without acknowledgement, delivered precedence, and an older Worker receipt causing bounded retry delay without acknowledging progress.
- [x] Run `node --test modules/control-plane/node/exchange.test.mts modules/control-plane/node/client.test.mts` and confirm the new assertions fail.
- [x] Store target progress in daemon-owned sidecars and sender progress in sent records, compare observation timestamps, include progress in reports, and record `storedProgressAt` only when the receipt covers the current observation.
- [x] Apply a fixed local backoff after a receipt without `storedProgressAt`; pass the clock into unreported-status selection so daemon ticks stay bounded.
- [x] Re-run both focused tests and confirm they pass.

### Task 4: Produce progress from existing delivery decisions

**Files:**
- Create: `modules/control-plane/node/delivery-progress.mts`
- Create: `modules/control-plane/node/delivery-progress.test.mts`
- Modify: `modules/control-plane/node/daemon.mts`
- Modify: `modules/control-plane/node/exchange.mts`
- Modify: `modules/control-plane/node/closed-resume.mts`
- Create: `modules/control-plane/node/codex-queue-run.mts`
- Modify: `modules/control-plane/node/codex-fixture.mts`
- Modify: `modules/control-plane/node/codex-queue.mts`
- Modify: `modules/control-plane/node/closed-delivery.mts`
- Test: `modules/control-plane/node/codex-queue.test.mts`
- Test: `modules/control-plane/node/codex-app-delivery.test.mts`
- Test: `modules/control-plane/node/closed-delivery.test.mts`

- [x] Add failing deterministic tests for listed idle Claude wake denial without a listener, active Claude busy status, granted idle status, unchanged-poll dedupe, Codex queue pending then unconfirmed after one attempt, redacted failures, and later delivery.
- [x] Run the three focused test files and confirm the new assertions fail for missing progress.
- [x] Implement the focused progress helper, preserve full local session state/runtime metadata, call its Claude observer before exchange reporting, and map existing Codex/closed-session outcomes to fixed codes.
- [x] Keep the Codex queued marker as the single attempt record; after the confirmation window only update progress and retain the unread message.
- [x] Re-run the focused tests and confirm they pass.

### Task 5: Present progress and document the contract

**Files:**
- Modify: `modules/control-plane/node/msg-cli.mts`
- Modify: `modules/control-plane/node/msg-cli.test.mts`
- Modify: `modules/control-plane/README.md`
- Modify: `modules/control-plane/ARCHITECTURE.md`

- [x] Add a failing CLI test for fixed actionable output and missing diagnostics.
- [ ] Focused CLI red run was not captured before implementation; the added assertion is verified green below.
- [x] Add the fixed description formatter and document schema, ordering, compatibility, privacy, and Worker-first rollout behavior.
- [x] Re-run the CLI test and confirm it passes.

### Task 6: Verify scope and behavior

**Files:**
- Review every changed file above.

- [x] Run all affected Node test files and record test counts.
- [x] Run the focused Worker messaging suite and record test counts.
- [x] Run root `npm run typecheck` and Worker `npm run typecheck`.
- [x] Run root `npm run test:bootstrap`: final root verification passed 360 tests, with 8 platform skips and 0 failures, using process-local Git Bash selection. Earlier restricted/WSL-alias runs failed and are retained as environment diagnostics.
- [x] Inspect `git diff --check`, `git status --short`, and the full diff for privacy fields, unrelated changes, and files over the repository size guideline.
- [x] Run one read-only `code-simplifier` review over the changed files and incorporate only scoped, behavior-preserving findings that retain green tests.
Final independent verification: 72 focused Node tests passed, 6 POSIX cases skipped on Windows; all 72 Worker tests passed across 15 files. Root and Worker typechecks passed. The scoped review finding about subsequent polls overwriting in-flight or failed progress was corrected and independently rechecked.

# Intercom Task Visibility Implementation Plan

> For agentic workers: use subagent-driven-development and test-driven-development; independent review precedes acceptance.

**Goal:** Inspect the task ID printed by Intercom and preserve local delivery-task identity (#133).

**Architecture:** Extend local record lookup/presentation. Keep delivery metadata separate from message grants. No Worker transport or policy changes in this step.

**Tech Stack:** TypeScript ESM `.mts`, Node.js type stripping, node:test.

## 1. Task lookup and output

- [x] Add failing regressions in node/task-cli.test.mts for reverse lookup, malformed/unknown/ambiguous IDs and task list.
- [x] Add focused lookup/presentation helpers as needed; reuse task-records.mts, exact matching, explicit read errors.
- [x] Distinguish cached request dispatch state from execution state; include target node.
- [x] Test local Codex latest-run paths/availability without content reads; supported Claude inspection command only.
- [x] Run node --test modules/control-plane/node/task-cli.test.mts modules/control-plane/node/msg-new.test.mts and npm run typecheck.

## 2. Durable delivery identity

- [x] Add failing inbox/Intercom regressions for confirmation/retry persistence and unchanged grant taskId.
- [x] Add separate validated delivery metadata to InboxRecord/mutation helpers.
- [x] Wire closed-resume.mts, closed-delivery.mts and runtime reuse paths found through graph discovery. Preserve the eventual runtime session identity.
- [x] Cover Codex and Claude using synthetic fixtures.

## 3. Acceptance

- [x] Update modules/control-plane/README.md for IDs, task list and local output; state remote control remains separate.
- [ ] Review complete diff, independent spec/security review and code-simplifier review of changed lines.
- [x] Run root typecheck, affected tests, required bootstrap suite with Git Bash first in Windows test PATH.
- [x] Execute final CLI against an isolated fixture, asserting identities and metadata.
- [ ] Commit via existing GitHub exception, PR with Closes #133 and reference #128, inspect CI, rebase merge if green.
- [ ] Verify target artifact. Retire completed owned worktree only after no following step depends on it.

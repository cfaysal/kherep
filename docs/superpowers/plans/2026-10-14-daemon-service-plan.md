# Node daemon service implementation plan

> For agentic workers: use subagent-driven-development, with one writer and specification/quality review before integration.

**Goal:** Complete #404 with a supported Windows/macOS daemon login service and measured upgrades.

**Architecture:** Add a bounded CLI service transaction with platform adapters, immutable source pinning and verified rollback. Capture startup source identity in daemon state and compare it with checkout/hooks in doctor.

**Tech stack:** Node TypeScript .mts, native launchctl/plutil on macOS, PowerShell ScheduledTasks on Windows, node:test.

## Task 1: Source identity and doctor

- [ ] Add `node/daemon-source.mts` and its tests, then extend `daemon-state.mts`, startup capture in `daemon.mts`, and doctor checks.
- [ ] Red test: daemon source remains the startup revision/fingerprint after checkout advances; missing identity is UNKNOWN; equivalent verified pin passes and hook mismatch fails.
- [ ] Run `node --test modules/control-plane/node/daemon-source.test.mts modules/control-plane/node/doctor.test.mts modules/control-plane/node/daemon-state.test.mts` before/after implementation.

## Task 2: Supported service definitions and source pin

- [ ] Add focused `service-*` modules for source snapshot, native definitions, local state/backup, supervisor and platform calls, keeping modules around 250 lines.
- [ ] Test absolute argv/XML/PowerShell escaping, current-user ownership, existing settings preservation, definition hash drift, immutable pin verification and dirty checkout refusal.
- [ ] Render platform definitions from a clean committed source and an explicit source/config/workspace binding. Never publish native definitions or environment values.

## Task 3: Transaction and CLI

- [ ] Add CLI install/upgrade/status/rollback parsing and help. `service` dispatch occurs before shared generic options.
- [ ] Test stop-before-start, exclusive lock, changed old process identity refusal, failed source/restart recovery, complete backup restoration and independently verified new daemon/auth/source.
- [ ] Implement bounded awaits; no PID-only kills, native session interruption, automatic permission change or unattended adoption.
- [ ] Run focused `node --test modules/control-plane/node/service*.test.mts`, then `npm run typecheck`, `npm run test:bootstrap`, `npm run test:control-plane`.

## Task 4: Documentation and review

- [ ] Update Control Plane architecture/README, main README diagram, installation instructions and changelog in the same branch.
- [ ] Independent specification review, then quality review, then behavior-preserving code simplification on this task's diff. Recheck affected tests after changes.

## Task 5: Live acceptance and delivery

- [ ] Coordinate exact selected Mac/Win-Claude sessions; inspect only selected current service metadata, capture reversible backups locally and preflight live source drift.
- [ ] Commit the reviewed candidate with public noreply identity. Use only documented product CLI to adopt/upgrade actual Windows/macOS services. Independently read fresh PID/auth/source and doctor result.
- [ ] Exercise bounded failure recovery without disrupting native sessions. Keep unique private receipts outside the public source.
- [ ] Publication audit, PR with `Closes #404`, attach PR, public CI, rebase merge, then main-source activation/readback on both targets.
- [ ] Record evidence and close the internal rollout tracker, verify #404 auto-closure, preserve references and clean the completed feature worktree.

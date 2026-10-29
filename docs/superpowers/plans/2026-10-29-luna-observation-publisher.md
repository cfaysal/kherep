# Luna Observation Publisher Implementation Plan

**Goal:** Implement issue #689 without live publication.

**Tech stack:** Node.js TypeScript ESM, local MCP stdio, existing Confluence broker, node:test.

**Architecture:** Luna extracts and publishes through a narrow local stdio MCP tool backed by the existing Codex Confluence broker modules. Its native role remains pinned and read-only. The Maestro independently validates receipts and reads targets. Claude is unchanged.

- [x] Add synthetic regression tests for strict result receipts, authority, placement, author readback, related/stitch failure, redaction and durable duplicate prevention; observe RED.
- [x] Implement bounded publisher policy, durable receipt journal, broker adapter and local stdio protocol. Canonical authority and credentials remain inside the process; no arbitrary CLI, paths, space override or update tool. Fail closed before creation on unknown identity or search, and after uncertain outcomes without retry.
- [x] Change the Codex observer and final-result hook to publication receipts, retaining candidate validation before publication and once-only handback correction with no publication.
- [x] Project the exact narrow tool table and full import closure transactionally, preserve historical upgrade recognition, settings and hook positions, and update source integrity mapping.
- [x] Align current routing, reminders, README, Codex guide and architecture with the publisher contract. Document restart and UNKNOWN native activation.
- [ ] Run focused synthetic tests, typecheck and bootstrap suite; inspect full diff and commit locally with neutral subject and noreply identity. No push, publication, live install or private configuration reads.

Acceptance: zero I/O for empty findings; literal canonical authority bound to resolved space; mapped placement and trusted service-account author; complete related lookup before each create; one page per finding with readback labels/body/parent/space; targeted verified stitching; safe durable receipts and no duplicate creation on repeat/correction/uncertain outcome; model pin and read-only role preserved; installer rollback and settings preserved.

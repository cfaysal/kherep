# Exact Inbox Reply Inspection Implementation Plan

**Goal:** Inspect one externally preclassified safe reply without reading other inbox records.

**Architecture:** Add `node/msg-inbox-exact.mts` and route exact selector flags before legacy commands. Reuse caller verification and the selected inbox record lock; verify a bounded nonsymlink file and emit only selected validated fields.

**Tech Stack:** TypeScript `.mts`, Node filesystem descriptors, SHA-256, Node test runner.

- [x] Add `msg-inbox-exact.test.mts` with a synthetic sent root, reply and unrelated poison record. Instrument opens, reads and enumeration; assert success and unchanged selected bytes. Run it against the existing CLI and capture the missing-option RED.
- [x] Extend `msg-cli.mts` parser/help and early dispatch. Reject exact flags outside an unmixed `inbox` invocation. Add exact preflight, selected root checks and locked bounded incoming read in `msg-inbox-exact.mts`.
- [x] Extend focused tests for every selector/mixed mode, owner/destination and identity failures, malformed/missing/unreadable/oversized/symlink files, tuple/hash/proxy/forwarding mismatch, exact selectors after the inbox option terminator, raw named sender with separate full target UUID, threaded sent parent without ancestor reads, busy lock and file replacement. Assert no unrelated incoming filesystem access.
- [x] Update `modules/control-plane/README.md` and `ARCHITECTURE.md` with interface, trust prerequisites and post-read envelope check. Inspect staged client closure; add packaging references only if reachable.
- [x] Run focused tests, existing messaging tests, `npm run typecheck`, `npm run test:bootstrap` and `npm run test:control-plane`; inspect diff. Leave source uncommitted for parent review and simplifier.

Verification: 97 focused tests passed, typecheck passed, and final bootstrap completed with 662 passed, four platform skips and zero failures. The broad Control Plane attempt was interrupted after sandbox socket/process failures. A scoped run outside that sandbox passed 108 of 111 fixtures, skipped one and retained two failures reproduced identically on the unchanged base. These are not reported as a passing full Control Plane suite. Independent security review and the behavior-preserving simplifier gate completed. All fixtures are synthetic; the implementation tests access no real inbox or session payloads.

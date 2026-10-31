# Codex Intercom receipts and owner coalescing (#711)

Goal: Fetch only offers content. A Codex Maestro explicitly ACKs the exact complete offer after processing; ordinary Stop never confirms it. Native pointers have one durable unresolved owner reservation.

Architecture: Add an opt-in Codex offer callback to shared delivery framing, leaving Claude defaults intact. Store opaque receipt metadata and generation fingerprints without duplicating bodies. ACK validates current owner/address/generation under inbox record locks and uses the existing delivered status transport. Explicit receive recovers offered content without incrementing attempts. Reserve the native owner atomically before budget consumption and per-ID attempts; retain uncertain history and release only after exact existing reconciliation.

Scope: Public synthetic fixtures only, isolated branch/worktree. No live installation, private inputs, network sends, push, commit, #706, original-owner resume, task settlement or Claude configuration edits.

- [x] RED: fetch+Stop does not deliver; receive recovery emits a receipt; ACK rejects wrong/stale/readdressed/refused/never-offered records, repeats idempotently and remains locally distinct from Worker persistence.
- [x] Implement focused Codex offer/ACK module and shared opt-in seam; keep bounds explicit and avoid receipts for truncated content.
- [x] RED: new accepted IDs behind a submitted or uncertain group remain unattempted through restart and concurrent reservation.
- [x] Implement durable owner reservation and exact reconciliation release, preserving immutable attempts and existing Queue cleanup safety.
- [x] Update transport instructions/docs and add a transparent synthetic Windows end-to-end harness.
- [x] Run focused functional/Claude regression tests, typecheck, bootstrap with process-local Git Bash PATH; inspect final diff and obtain read-only review/simplification.

Commands: `node --test --test-reporter=tap --test-concurrency=1 modules/control-plane/node/codex-inbox-ack.test.mts modules/control-plane/node/codex-queue-producer.test.mts`; `npm run typecheck`; `npm run test:bootstrap`.

Known scope boundary: resumed Codex task/wake/runner settlement remains unchanged and uses its existing completion contract. #711 changes interactive original-owner prompt/CLI intake only. The unchanged closed-task test needs child-only removal of inherited CODEX_THREAD_ID for synthetic isolation; the production identity guard remains intact.

# Observation lookup classification implementation plan

**Goal:** Correct safe observation failure receipts without broadening authority or network behavior.

**Architecture:** Keep classification inside the observation adapter and publisher. A small typed helper carries only fixed binding/network/timeout codes. Existing strict hook parser imports the common receipt policy. The scoped installer recognizes exact public predecessor bytes and snapshots the helper.

**Tech stack:** Node TypeScript type stripping, node:test, tsc.

1. Add failing tests to `observation-publisher.test.mts`, `observation-adapter.test.mts`, `codex/hooks/obs-result-policy.test.mts`, `codex/hooks/obs-result-check.test.mts`, and `codex/install-observations.test.mts`. Assert distinct null/throw/mismatch results, malformed/incomplete collection refusal, safe explicit DNS/timeout diagnoses, no canary leaks or retries, predecessor upgrade, drift refusal and rollback.
2. Run `node --test modules/atl-jira-brokers/observation-publisher.test.mts modules/atl-jira-brokers/observation-lookup.test.mts modules/atl-jira-brokers/observation-adapter.test.mts codex/hooks/obs-result-policy.test.mts codex/hooks/obs-result-check.test.mts codex/install-observations.test.mts`; record meaningful failures.
3. Add `modules/atl-jira-brokers/observation-lookup.mts`; change only the publisher space phase and narrow broker checks. Add exact safe codes to `observation-result.mts` and exact predecessor recognition in `codex/install-observations.mts` with public snapshot `codex/parity/observation-lookup-predecessor.json`. Include the helper in the fixed observation source lists.
4. Repeat the focused command until GREEN. Run `npm run typecheck` and `npm run test:bootstrap`. Keep the existing policy, stdio and journal regressions in the focused checks.
5. Update `docs/CODEX.md` and `codex/ARCHITECTURE.md` with exact safe-code semantics and actual Desktop acceptance requirements. Inspect `git diff --check`, `git diff --stat` and full diff. Return changes and precise verification to the parent without commit, push, PR, native runs or live publication.

Review additions: preserve existing case-insensitive space keys and trimmed canonical queries, explicitly reject neighboring keys, and require exactly one bounded JSON result for nonempty Link metadata only on the exact spaces endpoint, in the text() read path before caching, preserving all downstream validation. Run `node --test modules/atl-jira-brokers/observation-publisher.test.mts modules/atl-jira-brokers/observation-lookup.test.mts` and `npm run typecheck` after these changes. The synthetic default-fetch child uses only generated files and explicit synthetic environment bindings, with no real network.

Correction verification: demonstrate RED for valid single-row Link metadata and exact e13 updater recognition, then run `node --test modules/atl-jira-brokers/observation-lookup.test.mts modules/atl-jira-brokers/observation-publisher.test.mts modules/atl-jira-brokers/observation-adapter.test.mts codex/install-observations.test.mts`, `npm run typecheck`, `npm run test:bootstrap`, and `git diff --check`. Preserve the Link-only empty regression and terminal/no-retry/privacy checks; verify e13 and 1532 upgrade, unknown broker drift refusal, and rollback after actual broker replacement. No native, live installer or publication runs belong to this worker.

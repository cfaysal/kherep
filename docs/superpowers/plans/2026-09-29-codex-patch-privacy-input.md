# Codex patch privacy input implementation plan

> Execute inline with one writer. Issue #140 contains the approved design and acceptance criteria. The operator explicitly approved repair, tests, PR/CI and local installation on 2026-09-29.

**Goal:** Allow valid public apply_patch requests through the existing privacy guard while retaining denials for protected targets, content and ambiguous input.

**Architecture:** Adapt only the apply_patch pre-privacy boundary in codex/hooks/hook-adapter.mts. Parse framed patch headers into absolute file operations, including move destinations. Preserve the original input and expose content without diff prefixes to the unchanged privacy evaluator. Existing shell normalization and post-hook extraction retain their behavior.

**Stack:** TypeScript .mts, Node native tests and the existing installer transaction.

## Steps

- [x] Reproduce installed denial and compare installed/source hashes before editing. The original object input is renamed Edit without file_path; string input is malformed.
- [x] Add codex/hooks/hook-adapter-privacy.test.mts. Run the real adapter and guard for string/input/patch wrappers, multiple operations, move destinations, protected content and malformed inputs. Capture RED before implementation: 6 failed, 1 passed.
- [x] Add strict privacy-only header extraction and normalization. Keep the original complete input. Reject missing framing/targets, unknown headers, C0 control characters and invalid moves. Strip diff +/- prefixes in the separate content view without removing the original input.
- [x] Run focused native tests: node --test codex/hooks/hook-adapter-privacy.test.mts codex/hooks/hook-adapter.test.mts codex/hooks/privacy-boundary-guard.test.mts. All 21 passed.
- [x] Review changed source and tests independently, preserving behavior and avoiding changes to the guard itself.
- [x] Run npm run typecheck, npm run test:codex and npm run test:bootstrap with Git Bash selected on Windows. Inspect diff and unchanged guard hash.
- [ ] Commit on fix/codex-patch-privacy-input and open a PR closing #140. Wait for exact-head CI and rebase-merge the reviewed result.
- [ ] Install the exact merged adapter with an isolated preview, source/target drift comparison and reversible backup. Preserve runtime configuration, permissions and all other installed files.
- [ ] Independently compare installed bytes and run public/denied hook canaries. Exercise an actual public apply_patch in this chat and verify the resulting file.
- [ ] Preserve evidence, remove the completed worktree after retained-ref and local-data checks, and report remaining unrelated acceptance gaps separately.

## Scope and risks

The separate historical Hook stats Failed counter remains unattributed. This patch addresses the reproduced Missing file_path denial only. No Worker deployment, MCP identity activation, permission change or cross-host rollout belongs to this repair. The original guard file remains byte-identical.

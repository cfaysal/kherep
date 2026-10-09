# Codex Hook Noise Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce routine Codex PostToolUse hook processes and make research-stop feedback identify the missing evidence while preserving every existing guard and watcher behavior in scope for issue #365.

**Architecture:** Replace the four separately projected post-edit watcher commands with one fixed dispatcher that normalizes the payload once and launches the same four public watcher files with argument arrays only when the wrapper is relevant or uncertain. Keep exact historical renderers for the four-command predecessor so the installer replaces only known owned fragments and leaves positional trust and custom hooks untouched. Research enforcement keeps its parser, thresholds, classifications, privacy text and one-continuation gate; only the fixed reason becomes evidence-specific.

**Tech Stack:** Node.js 24, erasable TypeScript `.mts`, `node:test`, GitHub Git Data API.

---

### Task 1: Lock the dispatcher contract with failing tests

**Files:**
- Create: `codex/hooks/post-edit-checks-routing.test.mts`
- Create: `codex/hooks/post-edit-checks-output.test.mts`
- Test: `codex/hooks/hook-adapter.test.mts`

- [ ] **Step 1: Add routing fixtures before implementation**

Cover direct `Edit`/`Write`/`MultiEdit`/`apply_patch`, one-target and three-target patches, move destinations, paths containing shell metacharacters, a supported read-only `functions.exec` wrapper, a supported direct patch wrapper, mixed wrappers and unknown/dynamic wrappers. Assert child counts: routine read `4 -> 0`, one edit `4 -> 4`, three targets `12 -> 12`, and unknown wrapper `4 -> 4`.

- [ ] **Step 2: Add output and failure fixtures before implementation**

Run synthetic watcher children that emit manifest/LOC/simplify plaintext, Umlaut JSON with `hookSpecificOutput.additionalContext` plus `systemMessage`, silence, and a non-zero failure. Assert one valid PostToolUse JSON document for simultaneous findings, empty stdout for success/no-op, retained `systemMessage`, and a visible non-zero child failure.

- [ ] **Step 3: Run the focused tests and record RED**

Run:

```sh
node --test codex/hooks/post-edit-checks-routing.test.mts codex/hooks/post-edit-checks-output.test.mts codex/hooks/hook-adapter.test.mts
```

Expected: FAIL because `codex/hooks/post-edit-checks.mts` and its fixed dispatcher interface do not exist.

### Task 2: Implement the fixed post-edit dispatcher

**Files:**
- Create: `codex/hooks/post-edit-checks.mts`
- Modify: `codex/hooks/hook-adapter.mts`
- Test: `codex/hooks/post-edit-checks-routing.test.mts`
- Test: `codex/hooks/post-edit-checks-output.test.mts`
- Test: `codex/hooks/hook-adapter.test.mts`

- [ ] **Step 1: Export the existing post normalization seam without changing pre phases**

Reuse `normalizePayloads(payload, "post")` so apply-patch path extraction and multi-target behavior stay identical. Do not change `pre`, `pre-privacy`, `pre-no-transcript`, `shellCommandsFromExec` or deploy approval normalization.

- [ ] **Step 2: Implement bounded wrapper classification**

Use the existing lexical nested-tool-call parser. Return zero watcher payloads only when every recognized call is in the explicit supported read-only set and parsing is complete. Route recognized direct edit/patch calls through existing post normalization. Any unknown, dynamic, malformed or mixed wrapper conservatively receives the old single normalized fallback. Do not add wildcard MCP exemptions, `fetch*` exemptions or shell-prefix heuristics.

- [ ] **Step 3: Run the four public watcher files with argv arrays**

Resolve exactly `manifest-watch.mts`, `loc-watch.mts`, `umlaut-translit-watch.mts` and `simplify-nudge.mts` beside the installed dispatcher. Spawn `process.execPath` with `--disable-warning=ExperimentalWarning`; pass each normalized payload on stdin and never interpolate a shell command.

- [ ] **Step 4: Aggregate output once**

Treat plaintext as additional context. Parse only valid watcher JSON, retain its additional context and system message, and emit exactly one valid PostToolUse hook JSON when any finding exists. Emit nothing on success/no-op. Forward child stderr and exit non-zero when a child fails so failure cannot look green.

- [ ] **Step 5: Run the focused tests and record GREEN**

Run the Task 1 command. Expected: all dispatcher and existing adapter cases pass with the measured child counts and output contract.

### Task 3: Project one command and preserve the exact predecessor

**Files:**
- Modify: `codex/lib/parity-config.mts`
- Create: `codex/lib/post-edit-dispatcher-upgrade.test.mts`
- Modify: `codex/lib/parity-config.test.mts`
- Modify: `codex/lib/retired-central-brain.mts`

- [ ] **Step 1: Add failing projection and trust-position tests**

Assert the current PostToolUse edit group has one dispatcher entry for matcher `Edit|Write|MultiEdit|apply_patch|functions\\.exec`; Windows rendering remains valid; attribution stays at PostToolUse group 1 entry 0 when enabled; custom groups and other events retain their positions. Assert the exact predecessor renderer has the old four watcher entries at group 0 entries 0 through 3.

- [ ] **Step 2: Add failing migration tests**

Feed exact four-watcher current/historical variants into `prepareManagedConfig`; assert replacement, idempotence, preserved `hooks.state` keys using real `<file>:<event>:<group>:<entry>` forms, unchanged custom hooks/operator tables and rejection of one-line unknown drift.

- [ ] **Step 3: Implement the current renderer and frozen predecessor**

Render one command for `codex-post-edit-checks.mts` in the current edit group. Add a dedicated predecessor renderer that reconstructs the immediately previous four-watcher bytes before applying later historical removals. Do not redefine `codex/lib/historical-managed-artifacts.mts` hashes and do not derive old renderers from the new current shape in a way that changes their bytes.

- [ ] **Step 4: Add the predecessor to managed fragment families**

Include the exact four-watcher variants in current and retired-Central-Brain recognition only where required. Preserve exact-fragment rejection semantics for unknown drift.

- [ ] **Step 5: Run focused renderer/migration tests**

Run:

```sh
node --test codex/lib/parity-config.test.mts codex/lib/post-edit-dispatcher-upgrade.test.mts codex/lib/config-preservation.test.mts codex/lib/managed-block-split.test.mts codex/lib/retired-central-brain.test.mts codex/lib/attribution-hook-config.test.mts
```

Expected: all pass; the four-watcher predecessor remains byte-exact and current trust positions match the required keys.

### Task 4: Make research-stop feedback evidence-specific

**Files:**
- Modify: `codex/hooks/research-stop.mts`
- Modify: `codex/hooks/research-stop.test.mts`

- [ ] **Step 1: Add the failing reason matrix**

Add missing-Brain, missing-graph, missing-both and complete cases. Keep the existing negative fake-call fixture. Assert `stop_hook_active: true`, missing and wrong types produce no extra block while exactly `false` can block. Assert a nonempty opt-out marker remains required.

- [ ] **Step 2: Pass missing evidence into the fixed reason**

Build concise fixed text for Brain-only, graph-only or both missing. Keep the privacy sentence. Do not change the 400-character/three-call substantial thresholds, ReadOnly/observation classification, structured-call lexer, code-change detection or one-continuation condition.

- [ ] **Step 3: Run the research tests**

Run:

```sh
node --test codex/hooks/research-stop.test.mts codex/hooks/research-transcript.test.mts codex/hooks/research-first.test.mts
```

Expected: all pass, including fake text/comment/string/regex/output/later-turn negatives already covered by the parser suite.

### Task 5: Install the dispatcher and test upgrade preservation

**Files:**
- Modify: `codex/install.mts`
- Modify: `codex/install.test.mts`
- Test: `codex/lib/post-edit-dispatcher-upgrade.test.mts`

- [ ] **Step 1: Add failing installer copy tests**

Assert an isolated install copies `post-edit-checks.mts`, `hook-adapter.mts`, `research-exec-parser.mts` and the four watcher dependencies, writes one current dispatcher command, upgrades the exact four-watcher block and settles byte-identically on reinstall.

- [ ] **Step 2: Add the dispatcher source and target**

Copy the dispatcher into `hooks/kherep-maestro/codex-post-edit-checks.mts`. Preserve the four public watcher source bytes. Add only dependencies imported by the dispatcher. Do not retire or rewrite the watcher target files.

- [ ] **Step 3: Verify unknown/custom/trust preservation**

Run the installer migration fixtures with custom hook groups, unrelated trust approvals and an unknown mismatched managed fragment. Expected: custom and unrelated trust text remains, the new dispatcher hash is left for normal trust review, and unknown drift refuses replacement.

### Task 6: Update public architecture documentation

**Files:**
- Modify: `codex/ARCHITECTURE.md`
- Modify: `docs/CODEX.md`
- Modify: `README.md` only if its architecture diagram needs a changed edge

- [ ] **Step 1: Document configured behavior**

Describe one projected PostToolUse dispatcher, its exact four watcher children, supported read-only wrapper silence, conservative fallback and single JSON aggregation. State that installed source and repository tests do not prove Codex Desktop execution or latency.

- [ ] **Step 2: Document migration and trust**

Name the one new dispatcher trust key at PostToolUse group 0 entry 0, removal of old group 0 entries 1 through 3, stable attribution at group 1 entry 0 and preservation of custom groups/other events. Keep live Desktop review UNKNOWN until measured separately.

### Task 7: Run acceptance gates and inspect the exact remote diff

**Files:**
- Verify: all files changed above
- Verify unchanged: `claude/hooks/manifest-watch.mts`, `claude/hooks/loc-watch.mts`, `claude/hooks/umlaut-translit-watch.mts`, `claude/hooks/simplify-nudge.mts`
- Verify unchanged: `codex/lib/historical-managed-artifacts.mts`

- [ ] **Step 1: Run focused functional tests**

Run all Task 2 through Task 5 commands. Expected: zero failures; report platform skips separately.

- [ ] **Step 2: Run repository gates**

Run:

```sh
npm run typecheck
npm run test:bootstrap
npm run test:codex
```

Expected: zero failures. Windows-only skips remain reported separately and are not counted as passes.

- [ ] **Step 3: Re-run key deny suites**

Run the relevant privacy, commit, deploy, dispatch and acceptance test files from `claude/hooks` and `codex/hooks`. Expected: existing deny behavior remains green.

- [ ] **Step 4: Inspect remote identity and scope**

Compare the final remote branch SHA to its expected parent with the GitHub API, inspect every changed file and verify the four watcher blob SHAs plus historical artifact file SHA equal the base commit. Do not install, deploy, merge or change live configuration. Record Desktop envelopes and latency as UNKNOWN pending the later target probe.

# Codex Research Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Enforce Kherep's evidence-first rule on Codex with a prompt reminder and a once-only Stop continuation backed by a local Codex rollout parser.

**Architecture:** Two native Codex hooks share local scope and broker-command helpers. The Stop hook reads only the local rollout named by the hook payload, selects the current main turn at `task_started`/`turn_id`, and recognizes structured tool calls; a small lexer inspects actual nested `tools.*(...)` calls inside `functions.exec` without counting comments, strings, user text, or tool output. The installer projects the files, recognizes the exact pre-feature managed block, and runs a research-specific Claude/Codex counterpart check.

**Tech Stack:** Node.js type-stripped TypeScript (`.mts`), Codex command hooks, `node:test`, TOML projection.

---

### Task 1: Codex rollout evidence parser

**Files:**
- Create: `codex/hooks/research-exec-parser.mts`
- Create: `codex/hooks/research-transcript.mts`
- Create: `codex/hooks/research-transcript.test.mts`

- [x] Write fixtures for `response_item` messages, `function_call`, `custom_tool_call`, `task_started`, direct graph tools, nested `functions.exec` calls, patch targets, and string/comment false positives.
- [x] Run `node --test codex/hooks/research-transcript.test.mts`; expect failure because the parser is absent.
- [x] Implement local JSONL parsing, current-turn selection, real-call lexical scanning, research facts, and substantial-turn classification.
- [x] Re-run the focused parser test; expect all cases to pass.

### Task 2: Native prompt and Stop hooks

**Files:**
- Create: `codex/hooks/research-common.mts`
- Create: `codex/hooks/research-first.mts`
- Create: `codex/hooks/research-first.test.mts`
- Create: `codex/hooks/research-stop.mts`
- Create: `codex/hooks/research-stop.test.mts`

- [x] Test in-scope prompt context, fixed private-safe output, nonempty opt-out reason, Brain plus code-graph enforcement, malformed/unreadable fail-open behavior, and `stop_hook_active === false` once-only behavior.
- [x] Run both hook tests; expect missing-module failures.
- [x] Implement the prompt reminder and `{ decision: "block", reason }` Stop response using the parser facts.
- [x] Re-run both hook tests; expect all cases to pass.

### Task 3: Projection, upgrade ownership, and research parity

**Files:**
- Modify: `codex/lib/parity-config.mts`
- Modify: `codex/lib/retired-central-brain.mts`
- Modify: `codex/install.mts`
- Modify: `codex/lib/parity-config.test.mts`
- Modify: `codex/install.test.mts`
- Create: `codex/lib/research-hook-parity.mts`
- Create: `codex/lib/research-hook-parity.test.mts`

- [x] Add failing projection tests for both hooks, an exact pre-research renderer, installation of every dependency, and a parity check that rejects a fixture missing one Claude research hook.
- [x] Run the focused projection/install/parity tests; expect failures for absent wiring.
- [x] Wire `research-first` into `UserPromptSubmit`, `research-stop` into `Stop`, copy all local dependencies, validate the two named Claude/Codex counterparts, and add the exact prior managed render to every managed-fragment family.
- [x] Re-run the focused tests, including synthetic upgrade and idempotence cases; expect all cases to pass.

### Task 4: Accurate documentation and full verification

**Files:**
- Modify: `codex/ROUTING.md`
- Modify: `codex/ARCHITECTURE.md`
- Modify: `docs/CODEX.md`

- [x] Document configured behavior, attempted-lookup semantics, fixed/no-transcript privacy behavior, malformed or unstable transcript fail-open paths, Stop precedence with acceptance, and live Desktop status as UNKNOWN.
- [x] Run `node --test` for the new hook and projection tests, then `npm run typecheck`, `npm run test:bootstrap`, and `npm run test:codex` with Git for Windows Bash first in `PATH` where needed.
- [x] Inspect `git diff --check`, the complete diff, and file sizes; report passing, failing, skipped, and untestable checks without claiming live installation.

### Verification receipt

- `npm run typecheck`: passed.
- `npm run test:codex`: 301 passed, 0 failed, 4 platform skips.
- `npm run test:bootstrap`: 360 passed, 0 failed, 8 platform skips outside the restricted sandbox. The first sandbox run failed on Git Bash temporary-directory access; the retry resolved those failures.
- Independent focused hook, research parity and projection suite: 37 passed, 0 failed, 0 skipped.
- Independent copied-hook CLI smoke: 6 checks passed, including missing research, once-only continuation, final opt-out, required graph evidence and private-safe output.
- Independent historical renderer comparison against the starting revision: 21 exact byte comparisons passed.
- Diff whitespace check: passed. Parser review and behavior-preserving simplifier review completed.
- Live Desktop hook execution: UNKNOWN; no live installation was performed. Publication audit was not completed because no external policy file was supplied. No publication or remote delivery is claimed.
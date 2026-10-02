# Verified Claude Code messaging MCP implementation plan

> For agentic workers: Execute inline with `executing-plans`, preserve one writer per worktree and request independent review before integration.

**Goal:** Fulfil #187 using the measured Claude native call join without changing Codex defaults or weakening identity/permission gates. Complete deployed acceptance remains separately tracked in #127.

**Architecture:** The native hook records the actual Claude session and call before HTTP. The HTTP handler supplies only the actual Claude tool-use ID; Registry derives the source session from that exact prior intent and rechecks its runtime. A separate capability requires an explicit node runtime opt-in. Client projection retains the existing stdio bridge and all other settings.

**Tech stack:** TypeScript `.mts`, Node type stripping, existing SQLite Registry and official stateless MCP transport. No new dependencies.

## Proven compatibility and baseline

- Mac Claude Code 2.1.283 native join: one actual call, matching hook/MCP call hashes, real hook session and argument digest, no fabricated metadata.
- A separate actual call also passed with a required UUID in the MCP schema. Existing tool schemas can remain unchanged.
- Both canaries use exact read-only tool grants, ordinary manual permissions, retained security hooks and independent process cleanup reads. They do not establish production approval or Desktop behavior.
- The isolated branch starts at `fec1960ce77cd96440a63f0248954cb1f44207de`: 25 focused Node and 21 focused Worker tests passed before edits. The retained `pre-claude-native-mcp-187` tag marks this source boundary.

## Task 1: Runtime opt-in and trusted intent

Files: `modules/control-plane/protocol-mcp.mts`, `node/policy.mts`, `node/client.mts`, `node/mcp-intent-hook.mts` and their focused tests.

- [x] Add failing tests for absent/false/string Claude opt-in, valid explicit opt-in, no Claude registration after local retraction, native Claude rewrite without a permission decision, supplied request ID denial and rejected durable receipt.
- [x] Add `CLAUDE_MCP_CAPABILITY = "mcp.messaging.claude.v1"` and `McpRuntime = "codex" | "claude-code"`. Preserve the existing base capability. A Claude registration must not carry a thread ID.
- [x] Parse `remoteMcp.claudeCode` only when it is literal `true` alongside the existing literal `enabled:true`. Advertise the extra capability only then.
- [x] Use `mcpRuntimeEnabled(policy, runtime)` at local registration, native hook and inbox execution. Codex continues to require only the existing opt-in.
- [x] Give the hook an explicit trusted `--runtime claude-code` invocation option. Existing two-argument invocation defaults to Codex. Claude returns `updatedInput` without `permissionDecision`; Codex retains its required allow-plus-rewrite result. Keep the existing eight-second durable ACK bound.
- [x] Run the focused Node tests until green and inspect the diff.

## Task 2: Exact runtime-specific Registry claim

Files: `protocol-mcp.mts`, `worker/src/mcp-http.mts`, `worker/src/mcp-registry.mts`, `worker/src/registry.mts`, `worker/src/node-session.mts`, associated Worker tests.

- [x] Write failing transport and Registry cases for valid Claude join, missing/mixed metadata, another call/runtime/node, changed arguments, expiry, runtime replacement, recovery and capability removal/re-enable.
- [x] Use a discriminated claim: Codex requires native session/thread/call; Claude supplies native call only. Common fields remain node, credential version, request ID, tool and digest. Native metadata parsing refuses ambiguous Codex plus Claude fields.
- [x] Resolve a Claude source session only from the matching retained intent. Recheck that exact session's current runtime and the extra runtime capability. Preserve transaction boundaries, TTL, idempotency and body exclusion. Do not synthesize a thread ID or overwrite another runtime's intent.
- [x] Removing only the extra capability transactionally removes retained Claude intents, preserving Codex credentials/intents. Removing the base capability still removes all MCP state.
- [x] Carry the verified runtime in the typed online inbox request. Older requests default to Codex; explicit Claude reads require the current local runtime opt-in before reading.
- [x] Run the focused Worker and Node tests, both typechecks and the full related MCP suites until green.

## Task 3: Explicit client projection

Status: accepted source checkpoint. Root replayed the fixed-population probe, passed the 21 initial
focused tests and the actual selected-runtime transaction regression, and independently read all
14 matching source bytes at the isolated installed target. Specification, quality and final scoped
simplifier reviews passed. The implementation's complete bootstrap run passed 375 tests with four
platform skips before the final comparator regression; the required final broad gates follow Task 4.
Native CLI/plugin loading and native Windows execution remain separate target gates.

Files: a dedicated `node/claude-mcp-client.mts` and tests, documented installer/activation entry, installed client graph checks.

Selected entry: a dedicated `bootstrap/install-claude-messaging-client.sh` reuses the existing bootstrap lock, path validation and reversible transaction. It installs only a closed managed client directory, preserving persistent Claude settings and MCP registries byte-for-byte. A hook-only plugin and separately named `kherep_messaging` MCP configuration activate per session through `--plugin-dir`, `--mcp-config` and `--strict-mcp-config`. Node and Worker runtime opt-in remain separate. Existing managed target drift or undeclared content must be refused before replacement; idempotent updates retain reversible backups.

- [x] Test an isolated candidate first: no default activation, exact five-tool hook matcher, explicit runtime argument, complete shared module graph, no listener or bearer in settings, preserved unrelated MCP entries/hooks/permissions and idempotent upgrade.
- [x] Produce the optional Claude client settings from explicit paths to the installed bridge, hook and non-secret config root. Preserve independent settings through the existing transaction/merge pattern. Keep node and Worker opt-in separate from client projection; grant no tools automatically.
- [x] Verify the installed candidate graph by executing the bridge and hook with synthetic state. Run bootstrap and existing Codex projection tests to retain backwards compatibility.

### Completed source checkpoints before Task 3

- Task 1: Root inspected the final scoped diff and independently passed 24 focused tests, the root typecheck and diff validation. Independent specification and quality reviews passed.
- Task 2: Root inspected the final production changes and independently passed 39 focused Node tests, 30 focused Worker tests, both typechecks and diff validation. Independent specification and quality reviews passed. The implementation's complete related runs passed 537 Node tests with seven skips and 118 Worker tests. Its Worker RED was recorded in tool output but its requested RED log was not retained; no claim relies on that missing file.
- Separate actual Claude discovery compatibility: the scoped live-session listing returned the actual native hook session in 266 ms, one required-schema native call joined, and all 16 independent receipt/process checks passed. This is not deployed adapter or production ACK acceptance.

## Task 4: Review, publication and actual target acceptance

- [x] Update `modules/control-plane/ARCHITECTURE.md`, `MCP.md`, the README flow and optional installation guide in the same change. Describe the runtime-specific native identity and explicit capability boundary.
- [x] Run final typechecks, related functional suites and required bootstrap gate. Keep passed, skipped and unavailable checks distinct.
- [x] Request independent correctness/security review and the required behavior-preserving simplifier review. Apply only bounded findings and rerun affected verification.
- [ ] Audit the complete public diff and history, commit with the intact hook, publish a PR referencing #127 and closing #187 after its criteria are met. Public CI runs normally; rebase merge only at green.
- [ ] Measure installed source identities before activation on both consuming hosts. Coordinate Worker rollout separately with Windows. Use reversible backups and inspect drift before any live update.
- [ ] Run actual native Claude calls through the accepted adapter, including denied missing/mismatched context, two-session isolation and bidirectional messaging. Read target receipts, never model final text, as acceptance evidence.
- [ ] Close only the fulfilled source/adapter issue; #127 and #128 retain their independent remaining criteria. Remove the owned completed worktree/branch after accepted integration and preserve immutable evidence.

### Final source verification

- Root's complete Node run: 547 passed, seven platform skips, zero failed.
- Root's complete Worker run: 23 files and 118 tests passed. The Worker bundle dry run passed with the committed route flag still disabled.
- Root's complete bootstrap run: 376 passed, four platform skips, zero failed.
- Both root and Worker typechecks passed. Existing Codex projection checks passed all 41 focused tests.
- Initial sandboxed Node and Worker runs could not perform required process queries and loopback listeners. The authorized reruns above used the required execution rights; the failed environment runs are retained separately.
- Independent final documentation review passed after the accepted specification, quality and scoped simplifier reviews for Tasks 1-3.
- The publication scan read every candidate source file and found no new review flags against the unchanged public baseline. Existing third-party and synthetic-fixture flags remain explicitly separate from a clean scanner exit.
- The actual native call through the installed accepted adapter remains pending. #187 must stay open until that target criterion is measured.

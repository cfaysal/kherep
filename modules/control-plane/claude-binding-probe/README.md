# Claude Code binding probe

This directory contains a disabled synthetic compatibility probe for
[issue #127](https://github.com/cfaysal/kherep/issues/127). It tests whether a
Claude Code `PreToolUse` hook can register the native tool call and whether the
matching MCP stdio request carries the same call identifier in
`_meta["claudecode/toolUseId"]`.

The probe has no installer or settings entry. It is not wired into Kherep and
must not be treated as a production adapter. It has no network listener, Worker
credential access, message, task, stop, or session-control capability.

## Compatibility status

Claude Code 2.1.274 is the minimum version for this design because that release
added the `mcp_server` provenance object to MCP tool hook input. The official
[hooks reference](https://code.claude.com/docs/en/hooks) says trust decisions
must use `mcp_server.source`, rather than a server name or `mcp__` prefix alone.
The hook therefore requires an exact configured source and exact configured
server name in addition to the exact tool name.

Observed 2026-10-02, the Windows root resolver was 2.1.258, so it was not ready
for this provenance test. Do not invoke its real client for this probe.

The [public issue #127 evidence](https://github.com/cfaysal/kherep/issues/127#issuecomment-5958977972)
shows that a real macOS Claude Code 2.1.283 CLI canary joined a genuine hook `tool_use_id` to
`_meta["claudecode/toolUseId"]`. That canary used a random request-ID rewrite
and an exact manual tool grant. This directory deliberately tests a different,
smaller design: direct lookup by the keyed native call ID, with no hook rewrite
and no hook allow decision. Its automated tests are SDK simulations. They do
not establish Windows compatibility, live adapter behavior, normal permission
prompt behavior, or acceptance of direct, parallel, resumed, or subagent calls.

`headersHelper` is connection-scoped authentication setup. It is not per-call
identity evidence and is not used here.

## Boundary

The hook considers only the exact tool
`mcp__kherep_claude_binding_probe__binding_probe`. Its input must contain one
bounded `syntheticNonce`, genuine bounded `session_id` and `tool_use_id`
strings, the `PreToolUse` event, and the configured `mcp_server` provenance.
Malformed exact calls fail closed with fixed codes. Unrelated tools produce no
output.

A successful hook writes a local association and produces no stdout. It returns
no `allow` decision and no `updatedInput`, so Claude Code continues through its
normal permission processing.

The stdio server exposes exactly one tool, `binding_probe`, whose strict input
contains only `syntheticNonce`. Model-supplied request, session, or call
identifiers are rejected by the schema. The server reads the call identifier
only from SDK callback metadata.

The external registry:

- creates a local random 32-byte key atomically;
- stores domain-separated HMAC-SHA-256 values for session, call, and nonce;
- expires associations after 30 seconds and keeps at most 128 live entries;
- consumes a matching association atomically on first success; and
- returns only fixed codes or a `hook_session_call_join` receipt containing
  keyed `sessionHash`, `callHash`, `nonceHash`, and `bindingHash` values.

The receipt means that one synthetic hook session and call were joined. It
makes no native Claude session, thread, conversation, or resume identity claim.
Raw identifiers and nonces are not stored in records or returned in results.
Corrupt state, replay, duplicate registration, invalid input, and storage
failures fail closed.

## Source-only verification

Use Node.js 24 or another version allowed by `package.json`:

```text
npm install --package-lock-only --ignore-scripts --offline
npm ci --ignore-scripts
npm test
npm run typecheck
```

Tests create and remove only their own synthetic temporary directories. The
stdio tests start actual SDK client and server child processes, including a
two-process first-consumption race. They do not read Claude settings,
configuration, hooks, transcripts, or session files.

The normal test suite creates a genuine dangling junction on Windows and a
dangling file symlink on other platforms. WSL is not required for `npm test`.
An additional Windows check can exercise a genuine dangling file symlink
through local WSL by setting a process-local test variable for one focused run:

```powershell
$env:KHEREP_TEST_WSL_FILE_SYMLINK='1'; node --test --test-name-pattern="dangling binding" registry.test.mts
```

That optional path fails rather than skips when WSL is unavailable or access is
denied. It does not start, install, or configure WSL.

## Future live validation

Activation requires later concrete authorization and a reviewed configuration
diff. Real direct, parallel, resume, and subagent tests must preserve normal
permission checks and existing guards. Do not copy the existing Codex hook,
discard guards, add a retry path, or use restricted, safe, or bypass-permission
modes as a substitute for the real permission flow. This component provides no
settings-mutating command.

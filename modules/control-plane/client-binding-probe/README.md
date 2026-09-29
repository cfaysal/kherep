# Codex Desktop client binding probe

This directory is a disabled-by-default compatibility probe for issue #127. It checks whether one exact `PreToolUse` invocation and the matching MCP call carry the same native client identity. It cannot read or send messages, inspect tasks, control sessions, open a network listener, or grant general tool approval.

This probe targets the Codex hook and MCP metadata contract. Do not install this hook in Claude: its outgoing identity metadata and hook approval behavior need a separate compatibility check. A Codex pass makes no Claude compatibility claim.

## What it proves

The hook accepts only `mcp__kherep_binding_probe__binding_probe` with one bounded synthetic nonce. It stores a 30-second intent in an operator-selected directory outside the checkout, then adds a random request ID to the tool arguments. The official MCP SDK stdio server checks native `sessionId`, `threadId`, and `callId` metadata against the intent. Results contain fixed codes and keyed SHA-256 hashes. Raw hook input, working directories, transcripts, session IDs and call IDs are not returned or logged.

A passing automated test proves the SDK transport preserves supplied request metadata. It does not prove that an installed Desktop build supplies those fields. Direct, Code Mode, resumed and parallel calls still require an operator-authorized actual-client canary. Until that canary passes, remote messaging remains unsupported through this route.

## Source-only verification

```text
npm test
npm run typecheck
```

The tests use temporary synthetic state. `transport.test.mts` starts real SDK stdio client and server processes, verifies missing and foreign identity rejection, and races two server processes against one idempotent intent.

## Candidate Codex configuration

Do not add these entries automatically. Before activation, verify the installed client source identity and current config schema, review the concrete diff, and preserve every existing MCP server, hook and approval rule. Codex loads MCP servers from native `mcp_servers` TOML tables and hooks from `[[hooks.PreToolUse]]`. The official configuration reference documents `command`, `args`, `enabled`, and per-tool `approval_mode`; the hooks reference documents inline TOML and `commandWindows`.

Use an absolute external state directory with owner-only access. Both processes receive it through the exact `--state-dir` argument. Neither process reads the state path from model input. The MCP entry remains disabled until the canary is explicitly activated.

Windows candidate for the MCP server:

```toml
[mcp_servers.kherep_binding_probe]
enabled = false
required = false
command = 'C:\absolute\path\to\node.exe'
args = ['D:\absolute\path\to\kherep\modules\control-plane\client-binding-probe\server.mts', '--state-dir', 'D:\absolute\path\to\synthetic-probe-state']
enabled_tools = ['binding_probe']

[mcp_servers.kherep_binding_probe.tools.binding_probe]
approval_mode = 'prompt'
```

macOS candidate for the same MCP server:

```toml
[mcp_servers.kherep_binding_probe]
enabled = false
required = false
command = '/absolute/path/to/node'
args = ['/absolute/path/to/kherep/modules/control-plane/client-binding-probe/server.mts', '--state-dir', '/absolute/path/to/synthetic-probe-state']
enabled_tools = ['binding_probe']

[mcp_servers.kherep_binding_probe.tools.binding_probe]
approval_mode = 'prompt'
```

Add one exact hook group to the same native Codex TOML layer. `command` is the macOS form. `commandWindows` is the Windows override and uses PowerShell's call operator for a quoted executable:

```toml
[[hooks.PreToolUse]]
matcher = '^mcp__kherep_binding_probe__binding_probe$'

[[hooks.PreToolUse.hooks]]
type = 'command'
command = '"/absolute/path/to/node" "/absolute/path/to/kherep/modules/control-plane/client-binding-probe/hook.mts" "--state-dir" "/absolute/path/to/synthetic-probe-state"'
commandWindows = '& "C:\absolute\path\to\node.exe" "D:\absolute\path\to\kherep\modules\control-plane\client-binding-probe\hook.mts" "--state-dir" "D:\absolute\path\to\synthetic-probe-state"'
timeout = 10
```

Keep normal MCP approval enabled. A valid exact-call rewrite returns the per-call `permissionDecision = "allow"` required alongside `updatedInput`; that rewrite does not approve the MCP tool itself. Do not add a `PermissionRequest` hook or a blanket allow rule. The probe hook denies malformed exact-tool calls and leaves unrelated tools untouched.

References: [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

## Actual-client canary

Use fresh synthetic nonces and record only client/server versions, fixed result codes and keyed hashes:

1. Enable only the candidate MCP entry after reviewing the exact config diff. Run one direct call and one Code Mode call. Each must return `binding_confirmed`.
2. Resume the same chat without restarting the app and make a fresh call. It must return `binding_confirmed`; compare its session and thread hashes with the pre-resume receipt.
3. Run fresh parallel calls in two chats. Each must succeed with its own call hash, and the chat identity hashes must remain separated.
4. Call without a hook-created intent, or with native metadata absent in the synthetic harness. It must fail with `intent_not_found` or `missing_native_meta`.
5. Confirm ordinary MCP approval still appears according to the existing policy. Any blanket approval behavior fails the canary.

Two negative cases belong to the SDK harness, not the model-driven canary:

- Replaying an old request ID from another chat through the SDK must return `identity_mismatch`. A model call cannot perform that replay through the exact hook because the extra `requestId` makes the hook input invalid.
- Repeating the exact completed transport call with the same request ID and call metadata must return the same receipt. A fresh model tool call has a new call ID and receives a new request ID, so it is not a transport replay.

Any missing native metadata, unexpected approval behavior, raw identifier output or cross-chat acceptance fails the canary. Source-only tests do not establish installed Desktop compatibility.

## Rollback

Set `mcp_servers.kherep_binding_probe.enabled = false`, then remove only its MCP tables and exact `PreToolUse` group after the client is no longer using them. Remove the external synthetic state directory according to the operator's normal local cleanup procedure. No other MCP server, hook, approval or application setting belongs to this probe.

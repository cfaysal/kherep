# Existing Desktop chat binding probe

Issue: #127. This bounded prototype establishes the client contract before remote
messaging is enabled. It has no message send, inbox, task or infrastructure access.

## Contract

An exact-tool synchronous PreToolUse hook receives the runtime's session and call
identities. It accepts only a synthetic nonce, saves a short-lived local intent
with keyed identity hashes, and returns the per-call allow required for updatedInput, with a random non-secret
request id. Both processes receive an absolute external state directory through an exact `--state-dir` argument. The MCP tool compares its native metadata against that intent. Missing
or mismatching identity, mutation and expired intent are denied. An exact duplicate
returns the same receipt. Raw hooks, session ids and call ids are never logged.
Normal MCP client approval remains separate and in force; the probe adds no PermissionRequest hook or blanket allow.

## Acceptance

Unit and SDK transport tests cover matching identity, wrong chat/call, absent
metadata, mutation, expiry and duplicate use. Operator client acceptance then runs
direct, Code Mode, resumed and parallel calls in the actual Desktop app, comparing
only hashed identities. Unsupported paths remain disabled. This prototype is not
production authentication and its success does not activate messaging permissions.

## Installation boundary

Keep the probe disabled by default. Prepare a native Codex TOML candidate with an exact matcher and MCP
entry, preserve other hooks/settings, verify the diff and get activation authority
before installing it. Remove only the probe's own entry afterwards. The probe state
stays outside source control. Use official SDK stdio transport to avoid opening a
local network listener for this identity-only check.

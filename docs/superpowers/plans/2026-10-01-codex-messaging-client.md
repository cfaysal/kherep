# Codex messaging client implementation plan

Issue: #166. The existing remote messaging Worker and node capability remain
disabled by default. This change supplies the missing opt-in Codex client path.

## C1 - requested behavior

Add a local stdio to Streamable HTTP bridge under `modules/control-plane/node`.
For every JSON-RPC message it reloads the current node config, effective policy
and private MCP credential, derives the credential-free `/mcp` URL from the node
control URL, and sends the bearer only in the HTTP `Authorization` header.
JSON-RPC, including native `params._meta`, crosses unchanged. Notifications that
receive HTTP 202 produce no stdio response. JSON and SSE responses are bounded
and returned as native JSON-RPC messages.

Add an explicit `InstallOptions.messagingClient` and
`--enable-messaging-client` opt-in. Only that opt-in installs the bridge, its
public imports and `mcp-intent-hook.mts`, renders the `kherep_messaging` stdio
table, and wires the exact five-tool PreToolUse matcher. Normal MCP approval is
left to Codex. The default installation remains byte-for-byte free of this MCP
table and hook.

## C2 - verification

Write failing tests before implementation for:

- native `_meta` byte structure reaching mock HTTP unchanged and missing `_meta`
  receiving the Worker's denial without client substitution;
- credential rotation A to B without bridge restart and policy disable between
  two calls preventing the second HTTP request;
- missing, symlinked, non-private, invalid and revoked credential state, invalid
  node/policy state, transport timeout/status/content type/oversize errors, and
  notification 202 handling, all with fixed sanitized output;
- no token in bridge argv, stderr/stdout or rendered Codex settings;
- installer default versus explicit opt-in table, exact hook matcher, copied
  dependency graph, CLI parse, and reinstall stability.

Run the focused node and Codex tests, `npm run typecheck`, and
`npm run test:bootstrap`. Inspect the final diff and file sizes. Actual Codex
Desktop direct and two-chat canaries remain target acceptance, not source-test
evidence.

## C3 - security and privacy

Credential reads accept only an owned regular file with private POSIX mode or a
current-user-owned Windows ACL restricted to that user, SYSTEM and local
administrators, and never follow a symlink. Missing, invalid, disabled or revoked local state fails
before HTTP. Request and response bytes and deadlines are bounded; redirects are
rejected. No generic listener, caller identity synthesis, metadata rewrite,
permission override, environment secret, credential argument or token logging is
introduced. Fixtures use reserved domains and synthetic identities only.

## C4 - scope integrity

Touch only the bridge and tests, Codex installer/projection and tests, and the
matching public documentation. Do not activate node or Worker policy, deploy,
install, push, merge, close #127/#128, alter guards, or refactor unrelated code.

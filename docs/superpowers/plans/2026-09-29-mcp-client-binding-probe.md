# Desktop client binding probe implementation plan

> For agentic workers: use subagent-driven-development for the bounded probe, with one writer and independent review.

**Goal:** Establish whether an installed Desktop runtime binds a trusted hook to the same MCP call.

**Architecture:** A local exact-tool hook persists an expiring intent containing keyed identity hashes. An official-SDK stdio server compares native metadata and returns an allowlisted synthetic receipt. It never sends a message or controls a task.

**Tech stack:** Native Node TypeScript (.mts), official MCP SDK 1.31.0, Zod 4.6.5, node:test.

## 1. Intent and receipt core

Files: modules/control-plane/client-binding-probe/binding.mts and binding.test.mts.

- [x] Add failing cases for valid binding, missing metadata, foreign chat/call, mutated nonce, expiry and duplicate effect.
- [x] Accept a bounded synthetic nonce and exact canonical tool only. Ignore unrelated hook payload fields without logging them.
- [x] Hash runtime session/call identities using a probe-only key created locally; never output the key or raw input.
- [x] Persist intent before returning rewritten arguments; fail closed on malformed/unreadable storage.
- [x] Check native metadata, expiry and nonce digest before returning a fixed receipt. Duplicate exact calls return the existing receipt; conflicting calls fail.
- [x] Bound input size and stored intent lifetime. Keep production authority explicitly out of scope.

## 2. Hook and SDK boundary

Files: hook.mts, server.mts and transport.test.mts in the same directory.

- [x] Hook reads bounded stdin, matches mcp__kherep_binding_probe__binding_probe, and returns updatedInput only for a validated synthetic probe.
- [x] Preserve normal client approval; do not implement a PermissionRequest approval or alter another hook.
- [x] Server exposes one read-only binding_probe tool using McpServer and StdioServerTransport, accessing native extra._meta.
- [x] SDK client transport test proves metadata survives and invalid calls return no raw identifiers or inputs.
- [x] Console output contains only protocol data; diagnostic errors are fixed codes.

## 3. Candidate installation and actual client evidence

Files: README.md and tsconfig.json in the probe directory; no automatic live installer.

- [x] Document native Codex TOML MCP and exact hook fragments, explicit external state arguments, disabled-by-default activation, scoped rollback, and limitations.
- [ ] Read installed source identity before activation; preserve existing settings and all approval hooks.
- [ ] Exercise direct, Code Mode, resume and parallel calls in an actual Desktop session, with cross-chat/missing-intent rejection.
- [x] Keep public automated evidence distinct from actual-client evidence. Keep SDK transport replay separate from fresh model calls. Do not activate remote messaging from a source-only pass.

Source-only implementation is complete. Installed-client activation and direct, Code Mode, resume and parallel canaries remain explicitly open.

## Verification

Run npm test in the probe directory, its TypeScript check, root typecheck and bootstrap before publication. Review final diff and dependency/license additions. Publish a compatibility receipt containing only versions, fixed result codes and keyed identity hashes. Unsupported paths remain disabled.

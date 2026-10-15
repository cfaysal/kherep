# Guarded Claude idle-wake recovery diagnostics

Issue: #414. This design documents and tests the existing Claude idle-wake contract. It does not add an enrollment command, broaden sender admission, or change the startup guard.

## Observed limitation

Claude idle wake belongs to the receiving Claude owner. The sender's runtime does not enter the receiver's wake decision after the message has been accepted. A synthetic regression therefore uses representative Claude and Codex caller UUIDs and requires the same receiver decisions for both. That regression is product behavior evidence only, not evidence from a live Claude or Codex owner.

The native `asyncRewake` listener can be attached only by a genuine owner hook event. A permission-bearing `UserPromptSubmit` or `Stop` may arm through wildcard policy eligibility. A `SessionStart` input without `permission_mode` has a stricter restart gate: the receiver must be listed by its exact immutable id or unique current name, a safe stored or transcript mode must exist, and current settings and launch metadata must rule out permission bypass. Wildcard, reply and task grants do not replace that explicit restart authority.

A policy edit can change what an already running listener accepts at its next poll. It cannot attach `asyncRewake` to an owner after the native hook process has exited. Fabricating listener files, resuming the owner into a possible copy, or starting a detached replacement listener would not repair that native association.

## Decision

Keep `node/wake-hook.mts` unchanged. Operators configure exact restart authority through the existing `wake.sessions` list in `policy.json`. Host-specific restoration and genuine owner activation remain rollout work outside the public product change.

Add a read-only `wakeReadiness` doctor check. It reports these observed facts separately:

- whether wake policy is enabled and an observed idle Claude session is generally eligible;
- whether that observed idle session has explicit restart authority;
- whether its remembered permission mode is recognized as allowed, restricted, or unknown;
- whether a listener lock and scope are both readable, share the same token, belong to a live process, and are within the listener lifetime;

Observed idle rows come only from a successful `sessions.json` snapshot no older than two daemon listing intervals. The writer preserves the listing's unseen-runtime marker. A fresh snapshot is labelled complete, partial, or unknown for a legacy file, and its counts always describe observed rows rather than the total current population. A missing, unreadable, invalid, future-dated, or stale snapshot yields `unknown`, never zero. A missing listener source is distinct from a failed read. Output is aggregate and exposes no listener token, policy path, or session id.

Intentional wake opt-out remains a known disabled state. The check does not derive a ready verdict from a remembered mode and listener files: the mode is historical, the kill switch and the lock's current idle state are separate evidence. Missing explicit restart authority is reported as one prerequisite for a missing-mode `SessionStart`, not as the cause of every absent listener.

## Verification

The receiver regression covers both synthetic caller UUIDs across wildcard-only restart refusal, exact-listing startup success, unknown and bypass refusal, and ordinary permission-bearing `Stop` wake. Diagnostic tests cover fresh, stale, missing and unreadable snapshots; complete, partial and legacy completeness; explicit versus wildcard authorization; recognized, restricted and unknown remembered modes; verified, missing, unreadable, stale and mismatched listeners; token redaction; and explicit opt-out.

Existing startup, restart, launch-mode, headless, parent-lifetime, listener ordering, budget, duplicate and reply-depth suites remain the guard evidence. Real Windows and macOS original-owner receipt is separate live rollout evidence and cannot be inferred from synthetic fixtures or doctor output.

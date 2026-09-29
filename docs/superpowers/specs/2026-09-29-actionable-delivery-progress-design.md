# Actionable Intercom Delivery Progress Design

## Scope

GitHub issue #138 closes the sender visibility gap in #128. A message that the target node has durably accepted may still wait for a hook, a permitted wake, or a closed-session fallback. The sender needs metadata-only evidence for that wait without changing the meanings of `accepted`, `delivered`, `replied`, `refused`, or `expired`.

This change uses the existing authenticated `message.status` path. It does not add a command channel, permission, task-control grant, transcript read, message-body copy, or live configuration change. The optional delivery task identifier is omitted because authenticated task lookup already exists and validating another association would widen the change.

## Protocol

`MessageStatusBody` gains optional `progress`, valid only with `state: "accepted"`:

```ts
interface MessageProgress {
  phase: "waiting" | "waking" | "fallback" | "failed";
  code: MessageProgressCode;
  observedAt: string;
  retryAt?: string;
}
```

Phase and code combinations are fixed and validated. A progress status cannot also carry `reason`. `observedAt` and `retryAt` are ISO timestamps, and `retryAt` cannot precede `observedAt`. Unexpected properties, raw errors, free text, local paths, commands, message text, and task identifiers are rejected.

The code set covers:

- waiting: `awaiting-user-turn`, `awaiting-turn-confirmation`, `target-busy`, `wake-unconfirmed`, `retry-pending`, `wake-disabled`, `wake-not-authorized`, `permission-restricted`, `operator-stopped`, `reply-limit`, `budget-exhausted`, `ambiguous-target`
- waking: `wake-pending`
- fallback: `fallback-starting`, `fallback-running`
- failed: `wake-failed`, `fallback-failed`

The receipt gains optional `storedProgressAt`, the observation time of the canonical progress persisted by the Worker. Old reports and old clients remain valid when progress is absent.

## Ordering and persistence

The Worker's authenticated node connection remains the reporter identity. A report is accepted only for a message whose current target is that node.

The Worker stores progress in additive message-table columns. While the canonical message state is `accepted`, a strictly newer `observedAt` replaces older progress. An identical duplicate receives a receipt without producing a second sender frame or audit row. Older or conflicting same-time progress cannot overwrite canonical progress. A late `accepted` report cannot modify `delivered`, `replied`, `refused`, or `expired`. Every forward state transition clears progress.

Sender reconnect replays the latest metadata-only status through the existing bounded status pages. The sender's local sent record applies the same monotonic rules, so delayed frames cannot restore old progress or replace a final state.

The target node keeps progress in daemon-owned `inbox/progress/<messageId>.json` sidecars, separate from delivery-hook-owned inbox bodies and receipt sidecars. A stale progress writer therefore cannot restore `accepted` over `offered` or a terminal state. It keeps `reportedProgressAt` separately from the accepted-state receipt. A successful socket enqueue does not acknowledge progress. Only a Worker receipt whose canonical `storedProgressAt` covers the current observation settles it. A receipt without that field, as produced by an older Worker, applies a bounded retry delay instead of falsely acknowledging progress or retrying every daemon tick.

## Producing actionable progress

A focused node helper updates metadata sidecars only for accepted or locally offered inbox records. It compares phase, code, and retry time before minting a new `observedAt`, preventing periodic daemon polling from generating status or audit noise.

For listed Claude Code sessions, the daemon's existing pending-delivery round reports without depending on a later hook:

- an active turn reports `waiting/target-busy`;
- a locally offered message reports `waiting/awaiting-turn-confirmation`;
- a policy-disabled or unlisted idle session reports the corresponding waiting code and tells the sender that the unread message needs the next user turn;
- an eligible idle session with an armed listener reports `waking/wake-pending`;
- an eligible idle session without an armed listener reports `waiting/awaiting-user-turn`.

A task grant remains eligible even without a general wake allowlist. An absent listener alone is not interpreted as a policy denial, and an active Claude turn is reported as busy.

For interactive Codex sessions, the existing single automatic queue attempt reports `waking/wake-pending`. Once `REOFFER_AFTER_MS` elapses without hook confirmation it becomes `waiting/wake-unconfirmed`. The message stays unread and a later legitimate hook may still deliver it. No automatic requeue or extra fallback task is added. Existing budget, permission, reply-depth, task-grant, and `codexApp` decisions map to fixed progress codes.

Closed-session fallback reports starting, running, policy-blocked, or redacted failure progress. Raw launch and resume errors remain local logs only.

## Presentation

`msg status` keeps the canonical state first and adds a fixed human description, observation time, and optional retry time. The descriptions state the next action for policy-blocked or unconfirmed wake paths. Missing progress is displayed as accepted without diagnostics and is never described as delivery success.

## Verification

Tests cover strict schemas, target authentication, same-state persistence and relay, stale and duplicate ordering, sender replay, older-Worker receipt backoff, local monotonic storage, CLI output, Claude idle/busy policy paths without hook invocation, one Codex queue attempt followed by unconfirmed progress, later delivery/reply precedence, and privacy field rejection. Focused node and Worker suites, both type checks, and bootstrap tests are required.
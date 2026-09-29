# Owner task control: implementation design for issue #134

## Scope and acceptance

Build on #133 local delivery identity. Support metadata-only remote status for delegated and local Intercom tasks, and confirmed remote stop for Codex tasks. Claude stop stays unsupported until equivalent process-tree verification exists. No generic command transport changes, transcript service, permission widening by default, or Desktop-chat visibility claim.

## Authority

- New explicit policy `sessions.ownTaskControl`, default false; new capability `sessions.own-task-control.v1`. Both requester and target need it; target sessions must also be enabled. Runtime policy still applies.
- Owner is authenticated node, not a claimed session. Preserve this trust boundary in docs and CLI. Existing delegate request permission alone is insufficient.
- Worker derives task grants from an existing delegated task's authenticated request provenance or from a source message whose stored target is the registering authenticated node. Metadata registration is immutable across owner/target/task associations and cannot replace operator-owned tasks.
- Derive targets from stored grants, never caller-chosen node/PID. Recheck revocation/capabilities at submit/query/retry; target rereads current policy at execution.

## Typed transport

Use explicit allowlisted task-control event names within the existing event envelope. Add a small protocol-task-control.mts with strict validators, bounded identifiers, fixed error codes and data-only payloads.

- register/registration.receipt: target registers local taskId plus sourceMessageId and runtime; Worker derives owner from stored message.
- submit: requestId, action status|stop, exact task reference. Status can resolve one owned source request/message ID for discovery. Stop requires taskId and expectedRunVersion.
- execute: authoritative operationId, taskId, action, owner, origin proof, grant version and expected run fingerprint. No arbitrary command or caller-selected target.
- result/result.receipt: target emits strictly allowlisted result, Worker commits it then receipts it.
- query/query.result: owner retrieves exact operation result by requestId. Pending attempts retain identity through timeout.

Persist `(ownerNodeId, requestId)` to one operation, exact request fingerprint and immutable task/target/action. Conflicting reuse denies; identical retries reuse results. The Registry owns both grant and operation ledger. NodeSession forwards typed events; it does not own a second independent control queue. Retry pending operations through the existing daemon exchange, reconnect and explicit query, with bounded batches. No effect relies on volatile websocket delivery.

## Node journal and run targeting

Use a hash of Codex taskId/runtime/pid/pidStart for opaque runVersion. Missing process identity means stopSupported=false/identity_unknown. Do not use sessionId, startedAt, updatedAt or deadline for run identity.

`task stop` first gets a fresh target status and binds stop to that run. Persist local operation journal before effect; persist sanitized result before sending. Completed operations only replay. If a daemon restarts with an executing operation, mark recovery_required and never automatically rerun it. The existing watch retry for operatorStoppedAt must skip that ambiguous run; retain the intent so autonomous wake remains blocked. Explicit future operator action remains possible.

Status is a pull measurement with observedAt. Replay of a historical successful stop remains historical, never evidence that a later continued run is stopped.

Hard source risks to resolve with tests:
1. NodeClient command handlers and the exchange loop may interleave. Prove serialization or guard the captured run identity around termination and final record writes. stopCodex currently writes a pre-await record after terminate; it must not overwrite a concurrently continued run.
2. stopCodex currently skips terminate if exit.json exists. This alone does not prove children ended after a failed root. Remote stop must not convert that shortcut into full-tree confirmation. If evidence is insufficient return identity_unknown/recovery_required, not success.
3. Repeated result delivery, lost receipts and target restarts must not cause a second signal against a later process.

## Data contract

Only IDs, origin/runtime, taskState, processState, opaque runVersion, observedAt/freshness, stopSupported/stopConfirmed and fixed errorCode. Never include title, prompt, directive, summary, transcript, local path, raw exception, PID or start-time details in new Worker records/frames. Keep local output access from #133.

Operation states: pending, succeeded, failed, denied, unknown. Process states: running, idle, closed, unknown. Distinguish persisted task state from measured process state. CLI timeout preserves requestId and tells the user that execution is unresolved, not cancelled.

## Implementation order

1. Strict protocol/default-off policy and authorization tests.
2. Worker metadata grants, operation ledger and routing; negative provenance tests.
3. Node persistent exchange and registration receipts using #133 metadata.
4. Pull status + CLI task status/control-result discovery; fresh/cache/offline tests.
5. Codex stop journal, run guard, result replay and crash handling. Test runtime boundaries and all races above.
6. Root and Worker typecheck, targeted Node tests, Worker Vitest/bundle, bootstrap, independent security/spec review and simplifier.
7. PR Closes #134, References #128. Activation/deployment is separately reviewed against the final artifact; no implementation agent changes live policy.

Use focused modules under 250 lines where practical, one writer per worktree. Avoid unrelated generic command repairs or auth framework refactors.

# Intercom task visibility

Issue: #133, a bounded step towards #128.

## Decision

Resolve outgoing requests by either request ID or exact dispatched task ID. Keep dispatch state separate from execution state. Retain local message-to-delivery-task identity and expose local output availability without reading output bodies.

Alternatives:
1. Print only request IDs. This avoids one lookup failure but hides the actual task.
2. Resolve both IDs and retain delivery metadata locally. Chosen as the smallest useful foundation for remote status and stop.
3. Cloud transcripts and generic remote commands exceed the scope and local-content privacy model.

## Behavior

- `task show <id>` resolves a local task, a request ID, or an exact dispatched task ID. Validate IDs before paths; ambiguous requests fail explicitly.
- `task list` labels requests separately from execution records.
- Local task detail includes runtime, task/session identity, recorded state/running flag and local-output metadata. Codex files are labelled latest run; availability is checked without reading content. Claude uses its existing supported inspection command, never invented file paths.
- Remote request detail identifies the target node and clearly describes locally cached dispatch information, not live execution state or Desktop-chat visibility.
- Incoming messages retain a separate delivery identity through confirmation/retry. Existing `taskId` remains the message authorization association. Wire new and reused local fallback paths for both runtimes, including eventual session identity.
- No transcript, message content, host path or new permission is sent to the Worker.

## Verification

Regressions: request/task lookup, malformed/unknown/ambiguous IDs, list labels, latest-run output availability, fallback creation/reuse, preserved message grants. Run typecheck, affected node tests, bootstrap and an isolated CLI fixture against the final artifact. Full remote control and cross-host acceptance remain in #128.

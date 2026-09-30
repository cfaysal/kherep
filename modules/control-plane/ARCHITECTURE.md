# Control Plane architecture

The Worker authenticates enrolled nodes over outbound WebSockets. `NodeSession`
terminates each connection; `Registry` owns shared identities, messages, task
requests and owner-control records in SQLite. Local node policy remains an
additional execution gate. The [README](README.md#architecture) maps the existing
modules and operator API.

The Worker keeps one authenticated WebSocket per node identity. When a newer
connection replaces it, the older daemon receives close code 4409, clears its
connection timers and exits instead of reconnecting. Unknown or revoked identity
code 4403 is terminal too; transport closes continue through the bounded backoff.

## Remote MCP candidate

The optional `/mcp` route composes a stateless official SDK v2 handler with the existing Registry and message router. It adds no protocol-session Durable Object. A per-node bearer authenticates HTTP, while each tool effect also requires a short-lived native call intent registered and durably acknowledged over that node's authenticated WebSocket. Registry claim and message creation share one transaction for write tools. Capability, credential version and exact session runtime are rechecked at claim time.

Inbox reads use a typed in-memory request on the originating `NodeSession`. The response is accepted only from the socket that received the request. Body text is returned to the waiting HTTP call and is absent from command history, Registry storage, audits and logs. Reading does not advance delivery state. [MCP.md](MCP.md) defines the complete flow, activation gates and tested limits.

The route flag and node capability both default off. Credential provisioning happens only on the authenticated node socket. The daemon applies policy changes on each exchange round and before processing authentication completion. Removing the MCP opt-in immediately blocks local inbox and intent handling and clears private local MCP exchange state. The daemon retries a reduced registration after a failed socket send; once received, Registry capability retraction transactionally invalidates the credential and intents. Reconnect polling resends only unacknowledged local intent metadata while enabled; idempotent Registry registration preserves the original expiry and does not rewrite an unchanged intent.

## Owner task control

```mermaid
sequenceDiagram
    participant Owner as Requesting node
    participant Registry as Worker Registry
    participant Target as Target node
    Owner->>Registry: Authenticated status or exact-run stop request
    Registry->>Registry: Resolve owner grant and persist operation
    Registry->>Target: Typed execution with immutable provenance
    Target->>Target: Recheck policy and provenance, journal before effect
    Target->>Target: Measure status or await exact process-tree termination
    Target->>Target: Persist completed result
    Target->>Registry: Allowlisted result metadata
    Registry->>Registry: Validate operation, runtime and run correlation
    Registry->>Target: Result receipt
    Registry->>Owner: Result with observation time and cache freshness
```

`protocol-task-control.mts` defines strict event bodies carried in the existing
`event` envelope. This does not widen the generic command allowlist.

- `worker/src/task-control-grants.mts` binds immutable task, owner, target and
  runtime identities to delegated requests or authenticated source messages.
  Source-message associations have monotonic versions; delayed registrations
  cannot restore an older discovery mapping. Existing task ownership is preserved.
- `worker/src/task-control-store.mts` persists operations by owner and request id.
  A conflicting reuse is denied. Results must match the recorded target, action,
  runtime and expected run. Pending operations can be retried by their exact id.
- `worker/src/task-control-registry.mts` checks ownership, capabilities and
  revocation before resolving, dispatching or returning a request. Routing and
  frames modules connect that store to authenticated node sockets.
- `node/task-control-registration.mts` retains successful grant receipts and
  registration history for local intercom delivery associations.
- `node/task-control-store.mts` journals execution before any effect and saves
  results before sending. Restart recovery reports uncertainty without replaying
  a process signal. The daemon serializes control operations across reconnects.
- `node/task-control-local.mts` checks current policy and local provenance, measures
  process identity and calls the awaited Codex stop path. A run hash binds task,
  runtime, process id and process creation time; these process details stay local.
- `node/task-control-cli.mts` queues requests and distinguishes a status timeout
  before stop submission from a pending submitted stop.

## Durable write budget

The Registry reconciles each changed session snapshot inside one atomic transaction:
new rows are inserted, absent rows are deleted, and existing rows are updated only
when stored metadata differs. Duplicate ids keep the final snapshot entry.
Session `updated_at` is the last metadata change, while directory `fetchedAt`
records response freshness. A duplicate sequenced node frame may advance its
cumulative acknowledgement, but it does not refresh liveness or dispatch again.

## Accepted-message delivery progress

Read-only `node/msg-inbox.mts` inspection resolves the caller's verified session references against both the current inbox target and the retained original `closedTo` address after fallback handover. It exposes the current destination and available delivery task/session identifiers. Hook delivery and `--receive` continue matching the current target exclusively, so inspection does not create a second delivery owner.

The target node reports optional fixed progress on the existing authenticated `message.status` path while the canonical state remains `accepted`. The Registry accepts it only from the stored target node, persists strictly newer observations in additive columns, relays the metadata-only projection to the sender, and clears it on a forward state transition. A same-state duplicate changes neither audit nor sender traffic.

Delivery hooks own `inbox/<messageId>.json`; the daemon owns `inbox/progress/<messageId>.json`; Worker receipts remain in `inbox/receipts/<messageId>.json`. This split prevents a stale daemon read and write from restoring an older delivery state. A receipt settles progress only when `storedProgressAt` covers the current observation. Nodes connected to an older Worker back off before retrying an unacknowledged observation.

Claude progress comes from the current successful session snapshot and freshly loaded node policy. Each accepted message resolves once: an exact session id precedes names, a unique name resolves to one session, and a shared name produces one stable `ambiguous-target` observation. An already offered message remains `awaiting-turn-confirmation`. Codex progress annotates the existing single queue or app-delivery attempt. Closed-session fallback annotates its existing start or resume path. These observations add no wake attempt, permission, transcript read, or message-body persistence.
## Trust and data boundaries

`sessions.ownTaskControl` defaults to false. Both nodes must advertise the dedicated
capability, and the target must permit the runtime. Revocation and target policy
remain effective after initial registration. Operator tasks are not owner grants.
An enrolled node is the authenticated principal; a session name is a routing label,
not a security boundary between Desktop chats.

Task-control storage contains identifiers, state, observation time and fixed error
codes. It does not transport prompts, message bodies, transcripts, local paths or
process ids. Existing message delivery and its body-retention rules are unchanged.
Fresh measurement and cached results are explicit; connectivity or missing data is
never evidence that a process stopped. Claude process state remains unknown and its
remote stop is unsupported until an equivalent live identity check exists.

## Compatibility and activation

Ship the Worker and node source together, then explicitly activate node policy.
Older nodes without the capability cannot participate. Existing task records without
trusted provenance are not granted ownership retroactively. A local intercom task
can register once its source message and delivery identity are available. Reverting
the opt-in policy disables execution without removing the durable audit records.

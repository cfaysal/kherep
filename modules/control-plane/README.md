# Kherep Control Plane (Phase 1)

A Cloudflare Worker that Kherep nodes connect to over an outbound WebSocket, plus the `kherep-node` daemon and CLI that runs on each node. Phase 1 covers enrollment, node identity, registration, liveness, a node/runtime/session registry and a fixed set of three read-only commands. Nothing in Phase 1 runs arbitrary commands on a node. The design and its decisions are recorded in GitHub issue #5. Phase 2 step 1 (GitHub issue #31) adds the messaging wire protocol and its routing and queue in the Worker; the node does not accept messages yet.

## Architecture

```
kherep-node --outbound WSS--> Worker kherep-control --> NodeSession Durable Object (one per node)
                                                   \--> Registry Durable Object (one per deployment)
operator ----HTTPS behind Cloudflare Access--> Worker --> Registry / NodeSession
```

| Part | Path | Role |
| --- | --- | --- |
| Protocol | `protocol.mts` | Message envelope, message types, the Phase 1 command set and the signed challenge bytes. Used by both sides |
| Worker | `worker/src/index.mts` | Routing and authentication only: `/health`, `/node/connect`, `/node/enroll`, `/api/*` |
| `NodeSession` | `worker/src/node-session.mts` | The node's hibernatable WebSocket, challenge handshake, pending-command log with seq/ack, offline alarm |
| Messaging protocol | `protocol-messages.mts` | `message.*` bodies, message states, the `messaging.v1` capability and their validators. Used by both sides |
| `Registry` | `worker/src/registry.mts` | SQLite tables `nodes`, `runtimes`, `sessions`, `enrollments`, `audit`; one-time codes; key binding; revocation |
| Message queue | `worker/src/message-store.mts`, `worker/src/message-routing.mts` | The Registry's `messages` table, state changes and expiry; pushing the resulting frames to connected nodes |
| Node | `node/cli.mts` | `kherep-node node onboard|status|unenroll` and `kherep-node daemon` |

Both Durable Object classes use SQLite storage (declared in the `exports` map with `"storage": "sqlite"`). `NodeSession` accepts the socket with the WebSocket Hibernation API, so an idle node does not keep the object in memory.

### Protocol

Every frame is JSON text with one envelope:

```json
{ "v": 1, "type": "command", "id": "<uuid>", "seq": 3, "ack": 2, "ts": "<iso8601>", "body": {} }
```

- Types: `challenge`, `auth`, `register`, `capabilities.update`, `sessions.snapshot`, `command`, `command.ack`, `command.result`, `event`, `error`, `message.send`, `message.deliver`, `message.status`.
- Server-to-node `seq` numbers are assigned to commands only; control frames carry `seq` 0. The node's `ack` is the highest command `seq` it has processed. Commands stay in the `NodeSession` log until acknowledged or answered, and a reconnect resends everything after the node's `ack` (at-least-once). The command `id` lets the node drop a duplicate without running it again.
- Liveness: the node sends the fixed frame `{"type":"ping"}` every 30 seconds. The Durable Object answers `{"type":"pong"}` through `setWebSocketAutoResponse`, which does not wake it.
- Offline detection: while a node is online, a `NodeSession` alarm runs every 5 minutes. It takes the later of the last message and the last auto-response; after 3 intervals without either, the node is marked `offline` in the registry and the alarm stops. A closed socket alone does not mark a node offline, so a reconnect within the backoff window does not flap its status.
- Reconnect: exponential backoff from 1 s with jitter, at most 60 s. A node whose key is unknown or revoked (close code 4403) stops instead of retrying.

### Commands

Phase 1 dispatches exactly `node.status`, `runtime.list` and `session.list`. The API refuses anything else, `NodeSession` refuses it again, and the node refuses it a third time against its local policy file, even when the command arrives authenticated. The local policy can narrow the set but never widen it; a malformed policy file allows nothing. `session.list` reports an empty list in Phase 1 because the node does not track agent sessions yet.

### Messages

A message goes from a session on one node to a session on another node. A session is addressed as `{ "nodeId": "<uuid>", "session": "<session id or name, 1-128 chars>" }`.

| Type | Direction | Body |
| --- | --- | --- |
| `message.send` | node to Worker | `messageId` (uuid), `fromSession`, `to` (address), `text` (1-16384 chars), optional `inReplyTo` (uuid) |
| `message.deliver` | Worker to target node | `messageId`, `from` (address), `toSession`, `text`, optional `inReplyTo`, `createdAt` (ISO 8601) |
| `message.status` | target node to Worker, Worker to sending node | `messageId`, `state`, optional `reason` (at most 256 chars) |

- States: `queued`, `accepted`, `delivered`, `replied`, `expired`, `refused`. A node may report `accepted`, `delivered`, `replied` and `refused`; `queued` and `expired` are set by the Worker only. Progress only moves forward; `refused` and `expired` are final. Only the target node of a message may report its state.
- Sender: the Worker takes the sending node from the authenticated connection, never from the body. A `from` field in `message.send` is ignored. Messages sent through the API carry the sender node id `operator` and the Access identity as the session.
- Idempotency: a repeated `message.send` with the same `messageId` from the same node creates no second message and is answered with the current state. The same `messageId` from another node is answered with an `error` frame.
- Routing: the Worker stores the message as `queued` and answers the sender with `message.status`. It sends `message.deliver` at once when the target node is connected, otherwise after the target's next successful authentication, oldest first. Every state the target reports is forwarded to the sending node when it is connected. Statuses for a sender that is not connected are not stored for later delivery; read them through `GET /api/messages`.
- Refusals: the Worker records `refused`, with a reason, and reports it to the sender when the target node is unknown or revoked, does not advertise the capability `messaging.v1`, or already has 100 queued messages. Revoking a node refuses every message still queued for it (reason `target node revoked`) and tells the senders.
- Expiry: a message still queued 24 hours after it was sent becomes `expired`, and the sender is told. Expiry is checked on every message operation and by a `Registry` alarm set to the earliest expiry of a queued message.
- The node daemon does not advertise `messaging.v1` yet. A `message.deliver` that arrives anyway is answered with `message.status` `refused`, reason `messaging not enabled on this node`.

## Security model

- **Node identity.** `kherep-node node onboard` generates an Ed25519 key pair locally. The private key is written as PKCS#8 PEM to `node-ed25519.pem` in the node's config directory with mode `0600` on POSIX systems; on Windows it inherits the ACL of the per-user config directory. It never leaves the host.
- **Enrollment.** An operator creates a one-time code through the API (default 10 minutes, bounded to 1-60 minutes, single use; only its SHA-256 hash is stored). The node sends the code, its public key, name, host facts and discovered runtimes to `/node/enroll`, and the registry binds a new `nodeId` to that public key.
- **Connection.** `/node/connect` is gated only by the signed challenge; nodes hold no Cloudflare Access credential. The server sends a random nonce; the node signs `kherep-control/v1/auth`, the nonce, its `nodeId` and a timestamp. The connection is accepted only for an enrolled, non-revoked key, a nonce issued on this connection within 30 seconds, and a timestamp within 60 seconds of server time. A captured auth message cannot be replayed on another connection because every connection gets a new nonce.
- **Operator API.** Every `/api/*` request must carry a valid `Cf-Access-Jwt-Assertion`. The Worker verifies it with `jose` against `<team domain>/cdn-cgi/access/certs`, with the team domain as issuer and the Access application AUD as audience, even behind an Access application, so a misconfigured route cannot expose the API. Without both values configured, `/api/*` answers 503.
- **Revocation.** `DELETE /api/nodes/{id}` deletes the key binding, marks the node revoked, clears its pending commands and closes its socket. Rotation is re-enrollment with a new key. `kherep-node node unenroll` destroys the local key and config and prints the `nodeId` for the operator to revoke; Phase 1 has no node-initiated revocation call.
- **Audit.** Enrollment, status changes, command dispatch and revocation are written to the registry's `audit` table with the acting identity. Every message send (from a node or through the API) and every message state change is audited with the message id, the target session, the state and the reason; message text never enters the audit table.
- **Message text retention.** The Worker keeps a message's text only while the message is `queued`. When the target node accepts it, or it is refused or expires, the text column is set to `NULL`; a message refused on send is stored without text. The remaining metadata (ids, sessions, state, reason, timestamps) stays in the `messages` table. The API never returns message text.

## Operator API

| Method and path | Purpose |
| --- | --- |
| `GET /api/nodes` | List nodes |
| `GET /api/nodes/{id}` | One node with runtimes, connection state and recent commands |
| `GET /api/sessions` | Sessions reported by all nodes |
| `POST /api/nodes/{id}/commands` | Body `{"command": "node.status"}`; only the three Phase 1 commands |
| `POST /api/enrollments` | Body `{"ttlSeconds": 600}` (optional); returns a one-time `code` |
| `DELETE /api/nodes/{id}` | Revoke a node |
| `POST /api/nodes/{id}/messages` | Body `{"session": "<target session>", "text": "...", "inReplyTo": "<uuid>"}` (`inReplyTo` optional); sends as `operator` and answers 202 with `messageId` and `state` (`queued`, or `refused` with a `reason`); 404 for an unknown node, 409 for a revoked one |
| `GET /api/messages?node={id}&limit={n}` | Message metadata, newest first, where the node is sender or target (`node` optional, `limit` 1-200, default 50); never the text |

## Setup

### Worker

The committed [`worker/wrangler.jsonc`](worker/wrangler.jsonc) contains placeholders only: no account id, no route and no hostname, and empty Access values. Keep the real values in a local override config outside the repository and deploy with it:

```jsonc
// /path/outside/the/repository/kherep-control.jsonc
{
  "$schema": "<checkout>/modules/control-plane/worker/node_modules/wrangler/config-schema.json",
  "name": "kherep-control",
  "main": "<checkout>/modules/control-plane/worker/src/index.mts",
  "compatibility_date": "2026-09-23",
  "account_id": "<your account id>",
  "workers_dev": false,
  "send_metrics": false,
  "routes": [{ "pattern": "control.example.com", "custom_domain": true }],
  "durable_objects": {
    "bindings": [
      { "name": "NODE_SESSION", "class_name": "NodeSession" },
      { "name": "REGISTRY", "class_name": "Registry" }
    ]
  },
  "exports": {
    "NodeSession": { "type": "durable-object", "storage": "sqlite" },
    "Registry": { "type": "durable-object", "storage": "sqlite" }
  },
  "vars": {
    "ACCESS_TEAM_DOMAIN": "https://<team-name>.cloudflareaccess.com",
    "ACCESS_AUD": "<Access application AUD tag>"
  }
}
```

```sh
cd modules/control-plane/worker
npm ci
npx wrangler deploy --config /path/outside/the/repository/kherep-control.jsonc
```

Then put a Cloudflare Access application with an allow policy for the operators in front of `control.example.com/api/*`. Leave `/node/*` outside Access. Deploying and creating these resources is an operator action; the repository never does it.

Durable Object classes are declared with the `exports` map, which replaces the legacy `migrations` array. A Worker deployed earlier with `migrations` (tag `v1`, `new_sqlite_classes`) moves to `exports` without data migration; the move is one-way, so do not return to `migrations` afterwards.

### Node

Node.js 22.18 or later on the 22 line, or 23.6 or later, no dependencies:

```sh
# The operator creates a code: POST /api/enrollments (through Access)
KHEREP_ENROLL_CODE=<code> node modules/control-plane/node/cli.mts node onboard --url https://control.example.com --name build-01
node modules/control-plane/node/cli.mts node status
node modules/control-plane/node/cli.mts daemon
```

The config directory is `KHEREP_CONFIG_DIR` when set, otherwise `%APPDATA%\kherep` on Windows, `~/Library/Application Support/kherep` on macOS and `$XDG_CONFIG_HOME/kherep` (default `~/.config/kherep`) elsewhere. The files live in its `control-plane/` subdirectory:

| File | Content |
| --- | --- |
| `node.json` | Non-secret config: control URL, `nodeId`, name, public key, key and policy paths |
| `node-ed25519.pem` | The private key, mode `0600` |
| `policy.json` | Local command allowlist, `{"version": 1, "allowedCommands": [...]}` |

Runtime discovery checks `PATH` for `claude` and `codex` without running them, and probes LM Studio (`127.0.0.1:1234`) and Ollama (`127.0.0.1:11434`) on loopback only.

The control URL must be an `https` origin; plain `http` is accepted only for a loopback development Worker.

## Tests

```sh
npm run test:control-plane          # node side and protocol, from the repository root
cd modules/control-plane/worker
npm ci
npm run typecheck
npm test                            # Workers Vitest integration, runs locally in workerd
npm run check:bundle                # wrangler deploy --dry-run: bundles and validates, deploys nothing
```

The Worker tests run inside the local `workerd` runtime. They cover the handshake (valid signature, wrong key, unknown node, revoked key, replayed and expired nonce), enrollment single use and expiry, seq/ack resend after reconnect, offline marking by the alarm, Access JWT rejection and the command allowlist, message routing (sender taken from the connection, duplicate ids, offline queue and flush, refusals, text removal, expiry, status forwarding, audit without text, both message endpoints), and drive the real node client over a WebSocket against the real `NodeSession`. [`test-vectors.json`](test-vectors.json) holds the RFC 8032 section 7.1 test key and a challenge signature that both sides must reproduce. The Worker has its own `package.json` so the root install stays free of Cloudflare tooling.

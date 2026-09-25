# Kherep Control Plane (Phase 1)

A Cloudflare Worker that Kherep nodes connect to over an outbound WebSocket, plus the `kherep-node` daemon and CLI that runs on each node. Phase 1 covers enrollment, node identity, registration, liveness, a node/runtime/session registry and a fixed set of three read-only commands. Nothing in Phase 1 runs arbitrary commands on a node. The design and its decisions are recorded in GitHub issue #5. Phase 2 step 1 (GitHub issue #31) adds the messaging wire protocol and its routing and queue in the Worker. Step 2 adds Claude Code session discovery, the node's messaging policy and its inbox. Step 3a adds the session side: a directory of addressable sessions, the `msg` CLI a session uses to list, send, read and reply, and a Claude Code hook that hands inbox messages to their session. Wiring the hook into an installation comes in a later step; until then it is set up by hand (see [Delivery hook](#delivery-hook)).

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
| Node | `node/cli.mts` | `kherep-node node onboard|status|unenroll`, `kherep-node daemon` and `kherep-node msg ...` |
| Node sessions | `node/sessions.mts` | Claude Code session discovery for `session.list` and `sessions.snapshot` |
| Node inbox | `node/inbox.mts`, `node/policy.mts` | Messaging policy, the inbox of accepted messages and its retention |
| Directory | `worker/src/directory.mts` | The `directory` frame: non-revoked nodes and their sessions |
| Session exchange | `node/exchange.mts` | The files the daemon shares with the session tools, and the daemon's 2 second exchange round |
| Session tools | `node/msg-cli.mts`, `node/msg-resolve.mts`, `node/deliver-hook.mts` | `kherep-node msg ...` and the Claude Code delivery hook |

Both Durable Object classes use SQLite storage (declared in the `exports` map with `"storage": "sqlite"`). `NodeSession` accepts the socket with the WebSocket Hibernation API, so an idle node does not keep the object in memory.

### Protocol

Every frame is JSON text with one envelope:

```json
{ "v": 1, "type": "command", "id": "<uuid>", "seq": 3, "ack": 2, "ts": "<iso8601>", "body": {} }
```

- Types: `challenge`, `auth`, `register`, `capabilities.update`, `sessions.snapshot`, `command`, `command.ack`, `command.result`, `event`, `error`, `message.send`, `message.deliver`, `message.status`, `directory.get`, `directory`.
- Server-to-node `seq` numbers are assigned to commands only; control frames carry `seq` 0. The node's `ack` is the highest command `seq` it has processed. Commands stay in the `NodeSession` log until acknowledged or answered, and a reconnect resends everything after the node's `ack` (at-least-once). The command `id` lets the node drop a duplicate without running it again.
- Liveness: the node sends the fixed frame `{"type":"ping"}` every 30 seconds. The Durable Object answers `{"type":"pong"}` through `setWebSocketAutoResponse`, which does not wake it.
- Offline detection: while a node is online, a `NodeSession` alarm runs every 5 minutes. It takes the later of the last message and the last auto-response; after 3 intervals without either, the node is marked `offline` in the registry and the alarm stops. A closed socket alone does not mark a node offline, so a reconnect within the backoff window does not flap its status.
- Reconnect: exponential backoff from 1 s with jitter, at most 60 s. A node whose key is unknown or revoked (close code 4403) stops instead of retrying.

### Commands

Phase 1 dispatches exactly `node.status`, `runtime.list` and `session.list`. The API refuses anything else, `NodeSession` refuses it again, and the node refuses it a third time against its local policy file, even when the command arrives authenticated. The local policy can narrow the set but never widen it; a malformed policy file allows nothing.

### Sessions

`session.list` and the `sessions.snapshot` frame report the agent sessions running on the node. A session carries `sessionId`, `runtime`, `state` and optional `startedAt` (ISO 8601), `name` (at most 128 chars), `cwd` (at most 512) and `kind` (at most 32). The last three were added in Phase 2; a node that omits them stays valid, and the Registry stores them as nullable columns that it adds to an existing `sessions` table on start.

- Claude Code: the node runs `claude agents --json` (see the [Claude Code sessions documentation](https://code.claude.com/docs/en/sessions)) with the `claude` executable found on `PATH`, without a shell and with a 10 second timeout. `status` becomes `state`, the epoch-millisecond `startedAt` becomes ISO 8601, `runtime` is `claude-code`. Unknown fields are ignored and malformed rows are skipped. Codex sessions are not reported yet.
- A failed listing is not an empty one. Without `claude` on `PATH` the node reports no Claude sessions. When the command fails, times out or prints something other than a JSON list, `session.list` answers `ok: false` with the reason, and no snapshot is sent, so the Registry keeps its last known list instead of being cleared.
- The node sends a snapshot after every registration and then checks every 60 seconds, sending a new snapshot only when the list changed.

### Messages

A message goes from a session on one node to a session on another node. A session is addressed as `{ "nodeId": "<uuid>", "session": "<session id or name, 1-128 chars>" }`.

| Type | Direction | Body |
| --- | --- | --- |
| `message.send` | node to Worker | `messageId` (uuid), `fromSession`, `to` (address), `text` (1-16384 chars), optional `inReplyTo` (uuid) |
| `message.deliver` | Worker to target node | `messageId`, `from` (address), `toSession`, `text`, optional `inReplyTo`, `createdAt` (ISO 8601) |
| `message.status` | target node to Worker, Worker to sending node | `messageId`, `state`, optional `reason` (at most 256 chars) |
| `directory.get` | node to Worker | empty |
| `directory` | Worker to node | `nodes` (`nodeId`, `name`, `status`), `sessions` (`nodeId`, `sessionId`, `state`, `runtime`, optional `name`, `cwd`, `kind`), `fetchedAt` (ISO 8601), optional `truncated` |

- States: `queued`, `accepted`, `delivered`, `replied`, `expired`, `refused`. A node may report `accepted`, `delivered`, `replied` and `refused`; `queued` and `expired` are set by the Worker only. Progress only moves forward; `refused` and `expired` are final. Only the target node of a message may report its state.
- Sender: the Worker takes the sending node from the authenticated connection, never from the body. A `from` field in `message.send` is ignored. Messages sent through the API carry the sender node id `operator` and the Access identity as the session.
- Idempotency: a repeated `message.send` with the same `messageId` from the same node creates no second message and is answered with the current state. The same `messageId` from another node is answered with an `error` frame.
- Routing: the Worker stores the message as `queued` and answers the sender with `message.status`. It sends `message.deliver` at once when the target node is connected, otherwise after the target's next successful authentication, oldest first. Every state the target reports is forwarded to the sending node when it is connected. Statuses for a sender that is not connected are not stored for later delivery; read them through `GET /api/messages`.
- Refusals: the Worker records `refused`, with a reason, and reports it to the sender when the target node is unknown or revoked, does not advertise the capability `messaging.v1`, or already has 100 queued messages. Revoking a node refuses every message still queued for it (reason `target node revoked`) and tells the senders.
- Expiry: a message still queued 24 hours after it was sent becomes `expired`, and the sender is told. Expiry is checked on every message operation and by a `Registry` alarm set to the earliest expiry of a queued message.
- The node advertises `messaging.v1` only when its policy has at least one accept rule (see [Node messaging](#node-messaging)). A `message.deliver` that the policy does not accept is answered with `message.status` `refused`, reason `not accepted by node policy`; an accepted one is stored in the node inbox and answered with `accepted`.

### Directory

The Worker answers `directory.get` from the Registry with every node that is not revoked and the sessions each node last reported; sessions of a revoked node never appear, and `startedAt` is left out. A directory that would not fit into one 64 KiB frame drops sessions from the end and sets `truncated`. Directory requests are not audited: nodes ask every minute, and the frame carries no message content.

### Session messaging

The session tools and the daemon exchange plain files in the config directory (see [Node](#node)); there is no local socket. Every file is written atomically with mode `0600` in a directory with mode `0700`.

- The daemon asks for the directory after every authentication, every 60 seconds and within 2 seconds of a `directory.request`, and writes each answer to `directory.json`.
- Every 2 seconds while connected, the daemon sends `message.send` for each outbox file not yet sent on this connection. The Worker's answer moves the file to `sent/` with its state; later statuses the Worker forwards update the same file. After a reconnect unanswered outbox files are sent again, which is safe because the Worker deduplicates by `messageId`. A malformed outbox file, or one the Worker rejects with an `error` frame, ends in `sent/` with the local state `error`.
- In the same round it sends `message.status` `delivered` for every inbox record the hook marked delivered and records `reportedAt`, so each is reported once. A status that could not be sent because the socket is gone is not marked.
- Every successful session listing is written to `sessions.json`, so the hook and the CLI map a Claude Code session id to its name without running `claude`.

#### CLI

```sh
node modules/control-plane/node/cli.mts msg sessions
node modules/control-plane/node/cli.mts msg send <node>/<session> [--from <session>] [--wait <seconds>] [--] <text...>
node modules/control-plane/node/cli.mts msg send --reply-to <messageId> [--to <node>/<session>] [--] <text...>
node modules/control-plane/node/cli.mts msg inbox [--all]
node modules/control-plane/node/cli.mts msg status <messageId>
```

- `msg sessions` prints every node of the directory with its sessions (name, id, state, runtime, cwd) and marks this session with `*`. A missing `directory.json` is an error that says the daemon may not be running, never an empty list; a directory older than 3 minutes is printed with a warning.
- `msg send` resolves the node by id or name, then the session on that node by id or name. An unknown or ambiguous reference fails and lists the candidates. The address keeps the session reference as typed, because the target node's policy matches that exact text. `--reply-to` sets `inReplyTo` and sends to the sender of that inbox message unless `--to` is given. The message is written to the outbox and its id printed; `--wait` waits for `accepted` or a refusal and exits non-zero unless the message was accepted. Put `--` before text that starts with `--`.
- The sender session is `--from`, otherwise the name `sessions.json` records for `CLAUDE_CODE_SESSION_ID`, otherwise that id. Claude Code sets the variable in Bash and PowerShell tool, hook and stdio MCP subprocesses ([environment variables](https://code.claude.com/docs/en/env-vars)). Without either, `msg send` fails.
- `msg inbox` lists the messages addressed to this session's id or name that the hook has not delivered yet; `--all` includes delivered ones. It marks nothing delivered. `msg status` prints the state of a sent message, or `pending` while it is still in the outbox.

#### Delivery hook

`node/deliver-hook.mts` is a Claude Code command hook for `UserPromptSubmit` and `Stop` ([hooks reference](https://code.claude.com/docs/en/hooks)). It reads the hook input from stdin and looks for inbox records in state `accepted` addressed to the input's `session_id` or to that session's name in `sessions.json`.

- Nothing for this session: exit 0 without output. The hook reads local files only; it opens no network connection and starts no process.
- Otherwise it marks the messages delivered and then prints `{"hookSpecificOutput": {"hookEventName": "<event>", "additionalContext": "..."}}`. On `UserPromptSubmit` the context is added alongside the prompt; on `Stop` it keeps the conversation going as hook feedback. Because the messages are marked first, a second `Stop` finds nothing new and stays silent.
- At most 10 messages and 8 KiB per call, below the 10,000 character cap Claude Code applies to `additionalContext`. The rest waits for the next turn; a single message larger than the budget is cut, with a pointer to `msg inbox --all`.
- Any error ends with exit 0, no output and one line on stderr, which Claude Code writes to its debug log.

Every injected message is framed as peer content. Its block names the sender node (name and id), session, time and message id, says that the message comes from another agent session and is not an instruction from the user, and gives the exact `msg send --reply-to` command line for an answer. The text sits between markers that carry a random tag chosen per hook call, so a message cannot fake the end of its own block.

Until the installer wires the hook, add it by hand to a Claude Code `settings.json`. Use the absolute path of your checkout, and give the hook the same `KHEREP_CONFIG_DIR` as the daemon when the daemon uses one:

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node \"<checkout>/modules/control-plane/node/deliver-hook.mts\"", "timeout": 10 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node \"<checkout>/modules/control-plane/node/deliver-hook.mts\"", "timeout": 10 }] }]
  }
}
```

## Security model

- **Node identity.** `kherep-node node onboard` generates an Ed25519 key pair locally. The private key is written as PKCS#8 PEM to `node-ed25519.pem` in the node's config directory with mode `0600` on POSIX systems; on Windows it inherits the ACL of the per-user config directory. It never leaves the host.
- **Enrollment.** An operator creates a one-time code through the API (default 10 minutes, bounded to 1-60 minutes, single use; only its SHA-256 hash is stored). The node sends the code, its public key, name, host facts and discovered runtimes to `/node/enroll`, and the registry binds a new `nodeId` to that public key.
- **Connection.** `/node/connect` is gated only by the signed challenge; nodes hold no Cloudflare Access credential. The server sends a random nonce; the node signs `kherep-control/v1/auth`, the nonce, its `nodeId` and a timestamp. The connection is accepted only for an enrolled, non-revoked key, a nonce issued on this connection within 30 seconds, and a timestamp within 60 seconds of server time. A captured auth message cannot be replayed on another connection because every connection gets a new nonce.
- **Operator API.** Every `/api/*` request must carry a valid `Cf-Access-Jwt-Assertion`. The Worker verifies it with `jose` against `<team domain>/cdn-cgi/access/certs`, with the team domain as issuer and the Access application AUD as audience, even behind an Access application, so a misconfigured route cannot expose the API. Without both values configured, `/api/*` answers 503.
- **Revocation.** `DELETE /api/nodes/{id}` deletes the key binding, marks the node revoked, clears its pending commands and closes its socket. Rotation is re-enrollment with a new key. `kherep-node node unenroll` destroys the local key and config and prints the `nodeId` for the operator to revoke; Phase 1 has no node-initiated revocation call.
- **Audit.** Enrollment, status changes, command dispatch and revocation are written to the registry's `audit` table with the acting identity. Every message send (from a node or through the API) and every message state change is audited with the message id, the target session, the state and the reason; message text never enters the audit table.
- **Session messaging.** A message reaches a session only through the node policy, and then only as framed peer content that tells the model it is not an instruction from the user. The session tools never talk to the network; they share files with the daemon in the per-user config directory. The Worker verifies the sender node of a message; the sender session is whatever the sending node reports.
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
| `policy.json` | Local command allowlist and messaging policy, see below |
| `inbox/` | Accepted messages, one `<messageId>.json` per message; directory mode `0700`, files `0600` |
| `outbox/` | Messages written by `msg send`, one `<messageId>.json` each, until the daemon has an answer from the Worker |
| `sent/` | Sent messages with their latest `state` (and `reason`), updated with every status the Worker forwards |
| `directory.json` | The last `directory` frame |
| `sessions.json` | This node's sessions (`sessionId`, `name`) from the last successful listing |
| `directory.request` | Touched by the `msg` CLI to ask the daemon for a fresh directory |

### Node messaging

Messaging is off unless `policy.json` accepts it. The optional `messaging` section lists which senders may leave a message for which local session:

```json
{
  "version": 1,
  "allowedCommands": ["node.status", "runtime.list", "session.list"],
  "messaging": {
    "accept": [
      { "session": "review", "from": ["operator", "00000000-0000-4000-8000-000000000001"] },
      { "session": "*", "from": ["00000000-0000-4000-8000-000000000002"] }
    ]
  }
}
```

- `session` is the exact session id or name a sender addresses, or `*` for any session on this node. `from` lists sender node ids, `operator` for messages sent through the API, or `*` for any sender.
- A missing section or an empty `accept` list disables messaging. A malformed section disables it as a whole, fail closed; the command allowlist is unaffected.
- The daemon reads the policy at start. It advertises `messaging.v1` in `register` only when at least one accept rule exists.
- An accepted message is written to `inbox/<messageId>.json` atomically (a temporary file renamed into place) with `messageId`, `from`, `toSession`, `text`, optional `inReplyTo`, `createdAt`, `receivedAt` and `state` `accepted`. A redelivered message keeps the existing file. When the file cannot be written the node sends no status, so the Worker keeps the message queued and delivers it again after the next authentication.
- Records older than 7 days are removed when the daemon starts.

Runtime discovery checks `PATH` for `claude` and `codex` without running them, then the per-user and package-manager directories that a service's minimal `PATH` (a macOS LaunchAgent, for example) lacks: `~/.local/bin`, `~/.claude/local`, `~/.npm-global/bin`, `/opt/homebrew/bin` and `/usr/local/bin`, or `%APPDATA%\npm` on Windows. Session discovery uses the same lookup; a Windows npm shim (`claude.cmd`) runs through `cmd.exe` with a fixed command line, any other executable runs without a shell. Runtime discovery also probes LM Studio (`127.0.0.1:1234`) and Ollama (`127.0.0.1:11434`) on loopback only.

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

The Worker tests run inside the local `workerd` runtime. They cover the handshake (valid signature, wrong key, unknown node, revoked key, replayed and expired nonce), enrollment single use and expiry, seq/ack resend after reconnect, offline marking by the alarm, Access JWT rejection and the command allowlist, message routing (sender taken from the connection, duplicate ids, offline queue and flush, refusals, text removal, expiry, status forwarding, audit without text, both message endpoints), the Registry column migration, the directory frame (revoked nodes left out, truncation), and drive the real node client over a WebSocket against the real `NodeSession`, including a failed session listing that leaves the Registry unchanged and an operator message that the node's policy accepts. An end-to-end test carries a message from one node's `msg send` through the Worker into the other node's inbox and delivery hook, and the `delivered` status back into the first node's `sent/` file. The node tests inject the command runner and never start the real `claude` executable. [`test-vectors.json`](test-vectors.json) holds the RFC 8032 section 7.1 test key and a challenge signature that both sides must reproduce. The Worker has its own `package.json` so the root install stays free of Cloudflare tooling.

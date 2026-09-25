# Kherep Control Plane (Phase 1)

A Cloudflare Worker that Kherep nodes connect to over an outbound WebSocket, plus the `kherep-node` daemon and CLI that runs on each node. Phase 1 covers enrollment, node identity, registration, liveness, a node/runtime/session registry and a fixed set of three read-only commands. Nothing in Phase 1 runs arbitrary commands on a node. The design and its decisions are recorded in GitHub issue #5.

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
| `Registry` | `worker/src/registry.mts` | SQLite tables `nodes`, `runtimes`, `sessions`, `enrollments`, `audit`; one-time codes; key binding; revocation |
| Node | `node/cli.mts` | `kherep-node node onboard|status|unenroll` and `kherep-node daemon` |

Both Durable Object classes use SQLite storage (declared in the `exports` map with `"storage": "sqlite"`). `NodeSession` accepts the socket with the WebSocket Hibernation API, so an idle node does not keep the object in memory.

### Protocol

Every frame is JSON text with one envelope:

```json
{ "v": 1, "type": "command", "id": "<uuid>", "seq": 3, "ack": 2, "ts": "<iso8601>", "body": {} }
```

- Types: `challenge`, `auth`, `register`, `capabilities.update`, `sessions.snapshot`, `command`, `command.ack`, `command.result`, `event`, `error`.
- Server-to-node `seq` numbers are assigned to commands only; control frames carry `seq` 0. The node's `ack` is the highest command `seq` it has processed. Commands stay in the `NodeSession` log until acknowledged or answered, and a reconnect resends everything after the node's `ack` (at-least-once). The command `id` lets the node drop a duplicate without running it again.
- Liveness: the node sends the fixed frame `{"type":"ping"}` every 30 seconds. The Durable Object answers `{"type":"pong"}` through `setWebSocketAutoResponse`, which does not wake it.
- Offline detection: while a node is online, a `NodeSession` alarm runs every 5 minutes. It takes the later of the last message and the last auto-response; after 3 intervals without either, the node is marked `offline` in the registry and the alarm stops. A closed socket alone does not mark a node offline, so a reconnect within the backoff window does not flap its status.
- Reconnect: exponential backoff from 1 s with jitter, at most 60 s. A node whose key is unknown or revoked (close code 4403) stops instead of retrying.

### Commands

Phase 1 dispatches exactly `node.status`, `runtime.list` and `session.list`. The API refuses anything else, `NodeSession` refuses it again, and the node refuses it a third time against its local policy file, even when the command arrives authenticated. The local policy can narrow the set but never widen it; a malformed policy file allows nothing. `session.list` reports an empty list in Phase 1 because the node does not track agent sessions yet.

## Security model

- **Node identity.** `kherep-node node onboard` generates an Ed25519 key pair locally. The private key is written as PKCS#8 PEM to `node-ed25519.pem` in the node's config directory with mode `0600` on POSIX systems; on Windows it inherits the ACL of the per-user config directory. It never leaves the host.
- **Enrollment.** An operator creates a one-time code through the API (default 10 minutes, bounded to 1-60 minutes, single use; only its SHA-256 hash is stored). The node sends the code, its public key, name, host facts and discovered runtimes to `/node/enroll`, and the registry binds a new `nodeId` to that public key.
- **Connection.** `/node/connect` is gated only by the signed challenge; nodes hold no Cloudflare Access credential. The server sends a random nonce; the node signs `kherep-control/v1/auth`, the nonce, its `nodeId` and a timestamp. The connection is accepted only for an enrolled, non-revoked key, a nonce issued on this connection within 30 seconds, and a timestamp within 60 seconds of server time. A captured auth message cannot be replayed on another connection because every connection gets a new nonce.
- **Operator API.** Every `/api/*` request must carry a valid `Cf-Access-Jwt-Assertion`. The Worker verifies it with `jose` against `<team domain>/cdn-cgi/access/certs`, with the team domain as issuer and the Access application AUD as audience, even behind an Access application, so a misconfigured route cannot expose the API. Without both values configured, `/api/*` answers 503.
- **Revocation.** `DELETE /api/nodes/{id}` deletes the key binding, marks the node revoked, clears its pending commands and closes its socket. Rotation is re-enrollment with a new key. `kherep-node node unenroll` destroys the local key and config and prints the `nodeId` for the operator to revoke; Phase 1 has no node-initiated revocation call.
- **Audit.** Enrollment, status changes, command dispatch and revocation are written to the registry's `audit` table with the acting identity.

## Operator API

| Method and path | Purpose |
| --- | --- |
| `GET /api/nodes` | List nodes |
| `GET /api/nodes/{id}` | One node with runtimes, connection state and recent commands |
| `GET /api/sessions` | Sessions reported by all nodes |
| `POST /api/nodes/{id}/commands` | Body `{"command": "node.status"}`; only the three Phase 1 commands |
| `POST /api/enrollments` | Body `{"ttlSeconds": 600}` (optional); returns a one-time `code` |
| `DELETE /api/nodes/{id}` | Revoke a node |

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

Node.js 22.18 or later, no dependencies:

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

The Worker tests run inside the local `workerd` runtime. They cover the handshake (valid signature, wrong key, unknown node, revoked key, replayed and expired nonce), enrollment single use and expiry, seq/ack resend after reconnect, offline marking by the alarm, Access JWT rejection and the command allowlist, and drive the real node client over a WebSocket against the real `NodeSession`. [`test-vectors.json`](test-vectors.json) holds the RFC 8032 section 7.1 test key and a challenge signature that both sides must reproduce. The Worker has its own `package.json` so the root install stays free of Cloudflare tooling.

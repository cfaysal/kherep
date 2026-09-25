import { PING_FRAME } from "../protocol.mts";
import { reconnectDelay } from "./backoff.mts";
import { NodeClient, type CommandHandlers } from "./client.mts";
import { connectUrl, type NodeConfig } from "./config.mts";
import { detectFacts, discoverRuntimes } from "./discovery.mts";
import { readPrivateKey } from "./identity.mts";
import { purgeInbox, storeMessage } from "./inbox.mts";
import { loadPolicy } from "./policy.mts";
import { listSessions } from "./sessions.mts";

// Application ping interval. The Worker answers PING_FRAME through
// setWebSocketAutoResponse without waking the Durable Object; Node's built-in
// WebSocket client cannot send protocol-level ping frames.
export const PING_INTERVAL_MS = 30_000;
// The session list is checked this often; a snapshot goes out only on change.
export const SESSIONS_INTERVAL_MS = 60_000;

export interface DaemonHandle { stop(): void; done: Promise<void> }

export function commandHandlers(config: NodeConfig, startedAt: number): CommandHandlers {
  return {
    "node.status": async () => ({
      nodeId: config.nodeId, name: config.name, facts: detectFacts(), uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    }),
    "runtime.list": () => discoverRuntimes(),
    // A failed listing rejects, and the command result reports ok:false.
    "session.list": () => listSessions(),
  };
}

export function startDaemon(config: NodeConfig, inboxDir: string, log: (line: string) => void = (line) => console.error(line)): DaemonHandle {
  const identity = readPrivateKey(config.privateKeyFile);
  if (identity.publicKey !== config.publicKey) throw new Error("private key does not match the enrolled public key");
  const policy = loadPolicy(config.policyFile);
  try {
    const purged = purgeInbox(inboxDir);
    if (purged > 0) log(`kherep-node: removed ${purged} inbox message(s) older than 7 days`);
  } catch (error) {
    log(`kherep-node: inbox purge failed: ${String(error)}`);
  }
  const client = new NodeClient({
    nodeId: config.nodeId, identity, policy, handlers: commandHandlers(config, Date.now()),
    facts: detectFacts, runtimes: () => discoverRuntimes(), sessions: () => listSessions(),
    storeMessage: (body) => { storeMessage(inboxDir, body); }, log,
  });

  let stopped = false;
  let attempt = 0;
  let socket: WebSocket | null = null;
  let retry: NodeJS.Timeout | null = null;
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => { finish = resolve; });

  const connect = (): void => {
    if (stopped) return;
    const ws = new WebSocket(connectUrl(config.controlUrl, config.nodeId));
    socket = ws;
    let ping: NodeJS.Timeout | null = null;
    let snapshots: NodeJS.Timeout | null = null;
    // Frames are handled strictly in order: command seq/ack depends on it. The
    // periodic snapshot joins the same chain, since the Worker drops a node
    // frame whose seq is not above the last one it saw.
    let chain = Promise.resolve();

    ws.addEventListener("open", () => {
      ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(PING_FRAME); }, PING_INTERVAL_MS);
      snapshots = setInterval(() => {
        chain = chain.then(async () => {
          for (const frame of await client.sessionsSnapshot()) if (ws.readyState === WebSocket.OPEN) ws.send(frame);
        }).catch((error: unknown) => log(`kherep-node: session snapshot failed: ${String(error)}`));
      }, SESSIONS_INTERVAL_MS);
    });
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const data = event.data;
      chain = chain.then(async () => {
        const wasAuthed = client.authenticated;
        for (const frame of await client.onFrame(data)) if (ws.readyState === WebSocket.OPEN) ws.send(frame);
        if (!wasAuthed && client.authenticated) {
          attempt = 0;
          log(`kherep-node: connected as ${config.nodeId}`);
        }
      }).catch((error: unknown) => log(`kherep-node: frame handling failed: ${String(error)}`));
    });
    ws.addEventListener("close", (event) => {
      if (ping) clearInterval(ping);
      if (snapshots) clearInterval(snapshots);
      client.connectionClosed();
      if (stopped) return finish();
      // Revoked or unknown keys will not succeed on retry; stop instead of hammering.
      if (event.code === 4403) {
        log("kherep-node: the control plane refused this node (unknown or revoked); stopping");
        stopped = true;
        return finish();
      }
      const delay = reconnectDelay(attempt++);
      log(`kherep-node: disconnected (${event.code}); reconnecting in ${Math.round(delay / 1000)} s`);
      retry = setTimeout(connect, delay);
    });
    ws.addEventListener("error", () => {
      // The close event follows and schedules the reconnect.
    });
  };

  connect();
  return {
    stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      if (socket && socket.readyState <= WebSocket.OPEN) socket.close(1000, "node stopping");
      else finish();
    },
    done,
  };
}

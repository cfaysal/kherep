import { PING_FRAME, type SessionInfo } from "../protocol.mts";
import { reconnectDelay } from "./backoff.mts";
import { NodeClient, type CommandHandlers } from "./client.mts";
import { pollCodexQueue } from "./codex-queue.mts";
import { pollCodexInbound } from "./codex-wake.mts";
import { connectUrl, type NodeConfig, type NodePaths } from "./config.mts";
import { detectFacts, discoverRuntimes } from "./discovery.mts";
import {
  DIRECTORY_INTERVAL_MS, EXCHANGE_INTERVAL_MS, exchangeOptions, pollExchange, recordingSessions, replyDepth,
} from "./exchange.mts";
import { readPrivateKey } from "./identity.mts";
import { purgeInbox, storeMessage } from "./inbox.mts";
import { loadPolicy } from "./policy.mts";
import { continueTask, startTask, stopTask, type RunnerDeps } from "./session-runner.mts";
import { listSessions } from "./sessions.mts";
import { pollTasks, recordRequestResult } from "./task-exchange.mts";
import { watchTasks } from "./task-watch.mts";

// Application ping interval. The Worker answers PING_FRAME through
// setWebSocketAutoResponse without waking the Durable Object; Node's built-in
// WebSocket client cannot send protocol-level ping frames.
export const PING_INTERVAL_MS = 30_000;
// The session list is checked this often; a snapshot goes out only on change.
export const SESSIONS_INTERVAL_MS = 60_000;

export interface DaemonHandle { stop(): void; done: Promise<void> }

// runner: with it, the session commands of item 5 (the client runs them only
// when the policy enables sessions).
export function commandHandlers(config: NodeConfig, startedAt: number,
  sessions: () => Promise<SessionInfo[]> = () => listSessions(), runner?: RunnerDeps): CommandHandlers {
  return {
    "node.status": async () => ({
      nodeId: config.nodeId, name: config.name, facts: detectFacts(), uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    }),
    "runtime.list": () => discoverRuntimes(),
    // A failed listing rejects, and the command result reports ok:false.
    "session.list": sessions,
    ...(runner ? {
      "session.start": (args) => startTask(args, runner),
      "session.stop": (args) => stopTask(args, runner),
      "session.continue": (args) => continueTask(args, runner),
    } satisfies Partial<CommandHandlers> : {}),
  };
}

export function startDaemon(config: NodeConfig, paths: NodePaths, log: (line: string) => void = (line) => console.error(line)): DaemonHandle {
  const identity = readPrivateKey(config.privateKeyFile);
  if (identity.publicKey !== config.publicKey) throw new Error("private key does not match the enrolled public key");
  const policy = loadPolicy(config.policyFile);
  try {
    const purged = purgeInbox(paths.inbox);
    if (purged > 0) log(`kherep-node: removed ${purged} inbox message(s) older than 7 days`);
  } catch (error) {
    log(`kherep-node: inbox purge failed: ${String(error)}`);
  }
  // Every successful listing also updates sessions.json for the session tools
  // and includes the Codex sessions the delivery hook recorded.
  const sessions = recordingSessions(paths, () => listSessions({ paths }), log);
  const runner: RunnerDeps = { paths, policy };
  const client = new NodeClient({
    nodeId: config.nodeId, identity, policy, handlers: commandHandlers(config, Date.now(), sessions, runner),
    facts: detectFacts, runtimes: () => discoverRuntimes(), sessions,
    storeMessage: (body) => { storeMessage(paths.inbox, body, Date.now(), replyDepth(paths, body.inReplyTo)); },
    taskRequestResult: (result) => recordRequestResult(paths, result),
    ...exchangeOptions(paths), log,
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
    let exchange: NodeJS.Timeout | null = null;
    let directory: NodeJS.Timeout | null = null;
    // Outbox records sent on this connection; a reconnect sends them again.
    const inflight = new Set<string>();
    const requestsInflight = new Set<string>();
    const send = (frame: string): boolean => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      ws.send(frame);
      return true;
    };
    // Frames are handled strictly in order: command seq/ack depends on it. The
    // periodic snapshot joins the same chain, since the Worker drops a node
    // frame whose seq is not above the last one it saw.
    let chain = Promise.resolve();

    ws.addEventListener("open", () => {
      ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(PING_FRAME); }, PING_INTERVAL_MS);
      snapshots = setInterval(() => {
        chain = chain.then(async () => {
          for (const frame of await client.sessionsSnapshot()) if (ws.readyState === WebSocket.OPEN) ws.send(frame);
          await watchTasks(runner, log);
        }).catch((error: unknown) => log(`kherep-node: session snapshot failed: ${String(error)}`));
      }, SESSIONS_INTERVAL_MS);
      exchange = setInterval(() => {
        chain = chain.then(async () => {
          pollExchange(client, paths, inflight, send);
          pollTasks(client, paths, policy, requestsInflight, send);
          // Peer messages for ended Codex task sessions resume them (issue #63).
          await pollCodexInbound(runner, log);
          // ... and wake idle interactive Codex sessions with a pointer (issue #66).
          // Not awaited: queue runs have their own lane and never block this chain.
          pollCodexQueue(runner, log);
        })
          .catch((error: unknown) => log(`kherep-node: message exchange failed: ${String(error)}`));
      }, EXCHANGE_INTERVAL_MS);
      directory = setInterval(() => {
        chain = chain.then(() => { client.directoryRequest().forEach(send); });
      }, DIRECTORY_INTERVAL_MS);
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
      for (const timer of [ping, snapshots, exchange, directory]) if (timer) clearInterval(timer);
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

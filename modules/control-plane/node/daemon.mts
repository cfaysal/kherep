import { PING_FRAME, type SessionInfo } from "../protocol.mts";
import { reconnectDelay } from "./backoff.mts";
import { NodeClient, type CommandHandlers } from "./client.mts";
import { deliverToClosed } from "./closed-delivery.mts";
import { codexHome } from "./codex-app.mts";
import { pollCodexQueue } from "./codex-queue.mts";
import { pollCodexInbound } from "./codex-wake.mts";
import { connectUrl, ensureDir, type NodeConfig, type NodePaths } from "./config.mts";
import { detectFacts, discoverRuntimes } from "./discovery.mts";
import { observeClaudeDeliveryProgress, observeCodexTaskProgress } from "./delivery-progress.mts";
import {
  DIRECTORY_INTERVAL_MS, EXCHANGE_INTERVAL_MS, exchangeOptions, pollExchange, recordingSessions, replyDepth,
} from "./exchange.mts";
import { readPrivateKey } from "./identity.mts";
import { purgeInbox, storeMessage } from "./inbox.mts";
import { loadPolicy } from "./policy.mts";
import { continueTask, startTask, stopTask, type RunnerDeps } from "./session-runner.mts";
import { listSessions } from "./sessions.mts";
import { recordAndPublishSessions } from "./periodic-session-publication.mts";
import { pollTasks, recordRequestResult } from "./task-exchange.mts";
import { watchTasks } from "./task-watch.mts";
import { handleTaskControlExecute, pollTaskControl } from "./task-control-exchange.mts";
import { executeTaskControl } from "./task-control-local.mts";
import {
  applyQueryResult, receiptResult, recordRegistrationReceipt, recoverOperations,
} from "./task-control-store.mts";
import {
  disableMcp, hasMcpCredential, pollMcpIntents, readMcpInbox, recordMcpCredential, recordMcpIntentReceipt,
} from "./mcp-local.mts";

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

export function startDaemon(config: NodeConfig, paths: NodePaths, log: (line: string) => void = (line) => console.error(line),
  sessionSource?: (signal?: AbortSignal) => Promise<SessionInfo[]>): DaemonHandle {
  const identity = readPrivateKey(config.privateKeyFile);
  if (identity.publicKey !== config.publicKey) throw new Error("private key does not match the enrolled public key");
  const policy = loadPolicy(config.policyFile);
  // Issue #72. For nodes enrolled before onboard created it: a sandboxed
  // `msg send` can write into the outbox but not create it.
  ensureDir(paths.outbox);
  try {
    const purged = purgeInbox(paths.inbox);
    if (purged > 0) log(`kherep-node: removed ${purged} inbox message(s) older than 7 days`);
  } catch (error) {
    log(`kherep-node: inbox purge failed: ${String(error)}`);
  }
  // Successful listings update sessions.json and include hook-recorded Codex sessions.
  let periodicDiscovery: AbortController | null = null;
  const source = sessionSource ?? ((signal?: AbortSignal) => listSessions({ paths, codexHome: codexHome(), signal }));
  const sessions = recordingSessions(paths, (signal) => {
    periodicDiscovery?.abort();
    return source(signal);
  }, log);
  const runner: RunnerDeps = { paths, policy, log };
  recoverOperations(paths);
  let taskControlInflight = new Set<string>();
  let mcpInflight = new Set<string>();
  if (policy.remoteMcp?.enabled !== true) {
    try { disableMcp(paths, mcpInflight); } catch (error) { log(`kherep-node: remote MCP cleanup failed: ${String(error)}`); }
  }
  const client = new NodeClient({
    nodeId: config.nodeId, identity, policy, handlers: commandHandlers(config, Date.now(), sessions, runner),
    facts: detectFacts, runtimes: () => discoverRuntimes(),
    sessions,
    storeMessage: (body) => { storeMessage(paths.inbox, body, Date.now(), replyDepth(paths, body.inReplyTo)); },
    taskRequestResult: (result) => recordRequestResult(paths, result),
    taskControlRegistrationReceipt: (body) => {
      taskControlInflight.delete("register:" + body.registrationId);
      recordRegistrationReceipt(paths, body);
    },
    taskControlResultReceipt: (body) => {
      taskControlInflight.delete("result:" + body.operationId);
      receiptResult(paths, body.operationId);
    },
    taskControlQueryResult: (body) => {
      taskControlInflight.delete("submit:" + body.requestId);
      applyQueryResult(paths, body);
    },
    mcpCredentialPresent: () => hasMcpCredential(paths),
    mcpCredential: (body) => recordMcpCredential(paths, body),
    mcpIntentReceipt: (body) => recordMcpIntentReceipt(paths, mcpInflight, body),
    mcpDisabled: () => disableMcp(paths, mcpInflight),
    readMcpInbox: (sessionId, limit) => readMcpInbox(paths, sessionId, limit),
    taskControlExecute: (body) => handleTaskControlExecute(paths, body,
      (execute) => executeTaskControl(execute, { nodeId: config.nodeId, paths, runner })),
    ...exchangeOptions(paths), log,
  });

  let stopped = false;
  let attempt = 0;
  let socket: WebSocket | null = null;
  let retry: NodeJS.Timeout | null = null;
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => { finish = resolve; });
  // One lane spans reconnects so an old socket cannot finish a state mutation
  // concurrently with the replacement connection.
  let chain = Promise.resolve();

  const connect = (): void => {
    if (stopped) return;
    const ws = new WebSocket(connectUrl(config.controlUrl, config.nodeId));
    socket = ws;
    let ping: NodeJS.Timeout | null = null;
    let snapshots: NodeJS.Timeout | null = null;
    let exchange: NodeJS.Timeout | null = null;
    let directory: NodeJS.Timeout | null = null;
    let exchangePending = false;
    // Outbox records sent on this connection, with their send time; an
    // unanswered one is sent again after SEND_RETRY_MS or a reconnect.
    const inflight = new Map<string, number>();
    const requestsInflight = new Set<string>();
    taskControlInflight = new Set<string>();
    mcpInflight = new Set<string>();
    const send = (frame: string): boolean => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      ws.send(frame);
      return true;
    };
    const publishRegistration = (frames: string[]): boolean => {
      if (frames.length === 0) return true;
      for (const frame of frames) if (!send(frame)) return false;
      client.registrationSent();
      return true;
    };
    // Allocate and publish every frame on the same lane. Periodic discovery
    // waits outside it so an unrelated slow listing cannot postpone native ACKs.
    ws.addEventListener("open", () => {
      ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(PING_FRAME); }, PING_INTERVAL_MS);
      snapshots = setInterval(() => {
        if (periodicDiscovery) return;
        const controller = new AbortController();
        periodicDiscovery = controller;
        void source(controller.signal).catch((error: unknown) => {
          if (!controller.signal.aborted) log(`kherep-node: session listing failed, snapshot skipped: ${String(error)}`);
          return null;
        }).then((listed) => {
          chain = chain.then(async () => {
            if (socket !== ws || ws.readyState !== WebSocket.OPEN) return;
            if (listed && !controller.signal.aborted) await recordAndPublishSessions(client, paths, listed, send, log, controller.signal);
            await watchTasks(runner, log);
            await deliverToClosed(runner, log);
          }).catch((error: unknown) => log(`kherep-node: session snapshot failed: ${String(error)}`));
          return chain;
        }).finally(() => { if (periodicDiscovery === controller) periodicDiscovery = null; });
      }, SESSIONS_INTERVAL_MS);
      exchange = setInterval(() => {
        // Coalesce ticks while one round waits or runs so inbound receipts
        // cannot accumulate behind redundant periodic exchange work.
        if (exchangePending) return;
        exchangePending = true;
        chain = chain.then(async () => {
          const current = loadPolicy(config.policyFile);
          publishRegistration(await client.refreshPolicy(current));
          observeClaudeDeliveryProgress({ ...runner, policy: current });
          observeCodexTaskProgress(runner);
          pollExchange(client, paths, inflight, send);
          pollTasks(client, paths, policy, requestsInflight, send);
          const enabled = current.sessions?.enabled === true && current.sessions.ownTaskControl === true
            && current.sessions.runtimes.length > 0;
          pollTaskControl(client, paths, taskControlInflight, send, Date.now(), enabled);
          await pollMcpIntents(client, paths, mcpInflight, send,
            async () => publishRegistration(await client.refreshPolicy(loadPolicy(config.policyFile))));
          // Peer messages for ended Codex task sessions resume them (issue #63).
          await pollCodexInbound(runner, log);
          // ... and wake idle interactive Codex sessions with a pointer (issue #66).
          // Not awaited: queue runs have their own lane and never block this chain.
          pollCodexQueue(runner, log);
        })
          .catch((error: unknown) => log(`kherep-node: message exchange failed: ${String(error)}`))
          .finally(() => { exchangePending = false; });
      }, EXCHANGE_INTERVAL_MS);
      directory = setInterval(() => {
        chain = chain.then(() => { client.directoryRequest().forEach(send); });
      }, DIRECTORY_INTERVAL_MS);
    });
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const data = event.data;
      chain = chain.then(async () => {
        publishRegistration(await client.refreshPolicy(loadPolicy(config.policyFile)));
        const wasAuthed = client.authenticated;
        const frames = await client.onFrame(data);
        let sent = true;
        for (const frame of frames) if (!send(frame)) { sent = false; break; }
        if (!wasAuthed && client.authenticated && sent) client.registrationSent();
        if (!wasAuthed && client.authenticated) {
          attempt = 0;
          log(`kherep-node: connected as ${config.nodeId}`);
        }
      }).catch((error: unknown) => log(`kherep-node: frame handling failed: ${String(error)}`));
    });
    ws.addEventListener("close", (event) => {
      for (const timer of [ping, snapshots, exchange, directory]) if (timer) clearInterval(timer);
      periodicDiscovery?.abort();
      periodicDiscovery = null;
      client.connectionClosed();
      if (stopped) return finish();
      // Revoked keys and a connection superseded by the same node identity
      // cannot succeed by reconnecting this daemon; stop instead of hammering.
      if (event.code === 4403 || event.code === 4409) {
        log(event.code === 4403
          ? "kherep-node: the control plane refused this node (unknown or revoked); stopping"
          : "kherep-node: another connection replaced this daemon for the same node; stopping");
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

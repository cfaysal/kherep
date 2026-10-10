import { PING_FRAME, type SessionInfo } from "../protocol.mts";
import { isTaskRuntime, type TaskRuntime } from "../protocol-tasks.mts";
import { reconnectDelay } from "./backoff.mts";
import { NodeClient, type CommandHandlers } from "./client.mts";
import { deliverToClosed } from "./closed-delivery.mts";
import { codexHome } from "./codex-app.mts";
import { forgetCodexSession } from "./codex-sessions.mts";
import { pollCodexQueue } from "./codex-queue.mts";
import { pollCodexInbound } from "./codex-wake.mts";
import { codexIntakeWindow } from "./codex-intake-window.mts";
import { connectUrl, ensureDir, type NodeConfig, type NodePaths } from "./config.mts";
import { recordDaemonState, withVerdict, type DaemonState } from "./daemon-state.mts";
import { detectFacts, discoverRuntimes } from "./discovery.mts";
import { observeClaudeDeliveryProgress, observeCodexTaskProgress } from "./delivery-progress.mts";
import {
  DIRECTORY_INTERVAL_MS, EXCHANGE_INTERVAL_MS, exchangeOptions, pollExchange, recordingSessions, replyDepth,
} from "./exchange.mts";
import { readPrivateKey } from "./identity.mts";
import { purgeInbox, storeMessage } from "./inbox.mts";
import { scheduleListenerSweep } from "./listener-sweep.mts";
import { loadPolicy, type NodePolicy } from "./policy.mts";
import { routeFrame } from "./readiness-lane.mts";
import { probeRuntime, type ProbeResult } from "./runtime-probe.mts";
import { createReadiness } from "./runtime-readiness.mts";
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
  answerMcpInbox, disableMcp, hasMcpCredential, offerMcpInbox, pollMcpIntents, readMcpInbox, recordMcpCredential, recordMcpIntentReceipt,
} from "./mcp-local.mts";

// Application ping interval. The Worker answers PING_FRAME through
// setWebSocketAutoResponse without waking the Durable Object; Node's built-in
// WebSocket client cannot send protocol-level ping frames.
export const PING_INTERVAL_MS = 30_000;
// The session list is checked this often; a snapshot goes out only on change.
export const SESSIONS_INTERVAL_MS = 60_000;

export interface DaemonHandle { stop(): void; done: Promise<void> }

const enabledRuntimes = (policy: NodePolicy): TaskRuntime[] =>
  (policy.sessions?.enabled ? policy.sessions.runtimes : []).filter(isTaskRuntime);

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

// probe: the runtime readiness probe (issue #197); tests replace it.
export function startDaemon(config: NodeConfig, paths: NodePaths, log: (line: string) => void = (line) => console.error(line),
  sessionSource?: (signal?: AbortSignal) => Promise<SessionInfo[]>,
  probe: (runtime: TaskRuntime) => Promise<ProbeResult> = (runtime) =>
    probeRuntime(runtime, { forgetSession: (threadId) => forgetCodexSession(paths, threadId) })): DaemonHandle {
  const identity = readPrivateKey(config.privateKeyFile);
  if (identity.publicKey !== config.publicKey) throw new Error("private key does not match the enrolled public key");
  const policy = loadPolicy(config.policyFile);
  // Issue #72. For nodes enrolled before onboard created it: a sandboxed
  // `msg send` can write into the outbox but not create it.
  ensureDir(paths.outbox);
  let state: DaemonState = { pid: process.pid, startedAt: new Date().toISOString() };
  recordDaemonState(paths, state, log);
  try {
    const purged = purgeInbox(paths.inbox);
    if (purged > 0) log(`kherep-node: removed ${purged} inbox message(s) older than 7 days`);
  } catch (error) {
    log(`kherep-node: inbox purge failed: ${String(error)}`);
  }
  // Issue #225: locks of wake listeners whose process is gone, now and hourly.
  const stopSweep = scheduleListenerSweep(paths, log);
  // Successful listings update sessions.json and include hook-recorded Codex sessions.
  let periodicDiscovery: AbortController | null = null;
  const source = sessionSource ?? ((signal?: AbortSignal) => listSessions({ paths, codexHome: codexHome(), signal }));
  const sessions = recordingSessions(paths, (signal) => {
    periodicDiscovery?.abort();
    return source(signal);
  }, log);
  // Issue #197: one readiness probe per enabled runtime at the start, then only
  // when a run needs a runtime whose verdict aged out (runtime-readiness.mts).
  // Each completed probe goes to daemon.json for doctor (issue #222), off the frame lane.
  const readiness = createReadiness(probe, { log, onVerdict: (runtime, verdict) => {
    state = withVerdict(state, runtime, verdict);
    recordDaemonState(paths, state, log);
  } });
  for (const runtime of enabledRuntimes(policy)) void readiness.check(runtime);
  const runner: RunnerDeps = { paths, policy, log, readiness };
  recoverOperations(paths);
  let taskControlInflight = new Set<string>();
  let mcpInflight = new Set<string>();
  if (policy.remoteMcp?.enabled !== true) {
    try { disableMcp(paths, mcpInflight); } catch (error) { log(`kherep-node: remote MCP cleanup failed: ${String(error)}`); }
  }
  const client = new NodeClient({
    nodeId: config.nodeId, identity, policy, handlers: commandHandlers(config, Date.now(), sessions, runner),
    facts: detectFacts, runtimes: () => discoverRuntimes(), readyRuntimes: () => readiness.ready(),
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
    readMcpInbox: (sessionId, limit, messageId) => readMcpInbox(paths, sessionId, limit, messageId),
    offerMcpInbox: (messageIds) => offerMcpInbox(paths, messageIds),
    answerMcpInbox: (messageIds) => answerMcpInbox(paths, messageIds),
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
  // Inbound commands that wait for a first readiness verdict (issue #197).
  let commands = Promise.resolve();

  const connect = (): void => {
    if (stopped) return;
    const ws = new WebSocket(connectUrl(config.controlUrl, config.nodeId));
    socket = ws;
    let ping: NodeJS.Timeout | null = null;
    let snapshots: NodeJS.Timeout | null = null;
    let exchange: NodeJS.Timeout | null = null;
    let directory: NodeJS.Timeout | null = null;
    let exchangePending = false;
    let intakeWindow: ReturnType<typeof codexIntakeWindow> | null = null;
    // Outbox records sent on this connection, with their send time; an
    // unanswered one is sent again with backoff (send-schedule.mts), or at
    // once after a reconnect, which starts with a new map.
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
        // Issue #197: a runtime that is not ready is probed again in the
        // background, at most every NOT_READY_TTL_MS, so a re-login is noticed
        // and advertised without a run asking for it.
        for (const runtime of enabledRuntimes(loadPolicy(config.policyFile))) readiness.revalidate(runtime);
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
        if (intakeWindow) { intakeWindow.tick(); return; }
        // Coalesce ticks while one round waits or runs so inbound receipts
        // cannot accumulate behind redundant periodic exchange work.
        if (exchangePending) return;
        exchangePending = true;
        chain = chain.then(async () => {
          const current = loadPolicy(config.policyFile);
          let applied = current;
          let published = publishRegistration(await client.refreshPolicy(applied));
          observeClaudeDeliveryProgress({ ...runner, policy: current });
          observeCodexTaskProgress(runner);
          pollExchange(client, paths, inflight, send);
          pollTasks(client, paths, policy, requestsInflight, send);
          const enabled = current.sessions?.enabled === true && current.sessions.ownTaskControl === true
            && current.sessions.runtimes.length > 0;
          pollTaskControl(client, paths, taskControlInflight, send, Date.now(), enabled);
          await pollMcpIntents(client, paths, mcpInflight, send, async () => {
            applied = loadPolicy(config.policyFile);
            const sent = publishRegistration(await client.refreshPolicy(applied));
            published = published && sent;
            return sent;
          });
          // Peer messages for ended Codex task sessions resume them (issue #63).
          // Keep runtime mutation serialized while the existing queue lane and
          // admitted Codex peer transport can progress (issue #369).
          const window = published ? codexIntakeWindow({ client, paths, policyFile: config.policyFile, policy: applied,
            connected: () => !stopped && socket === ws && ws.readyState === WebSocket.OPEN,
            send: frame => !stopped && socket === ws && send(frame),
            exchange: () => pollExchange(client, paths, inflight, send),
            queue: () => pollCodexQueue({ ...runner, policy: applied }, log), defer: handleFrame, log }) : null;
          intakeWindow = window;
          try { await pollCodexInbound(runner, log); }
          finally { await window?.drain(); intakeWindow = null; }
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
      if (intakeWindow?.frame(data)) return;
      const route = routeFrame(data, paths);
      if (!route.command) handleFrame(data);
      else {
        // Issue #197: a session command for a runtime without any readiness
        // verdict waits for its first probe here, outside the frame lane;
        // commands keep their order (readiness-lane.mts).
        const runtime = route.runtime;
        commands = commands.then(async () => {
          if (runtime) await readiness.check(runtime);
          if (socket === ws) handleFrame(data);
        }).catch((error: unknown) => log(`kherep-node: command handling failed: ${String(error)}`));
      }
    });
    const handleFrame = (data: string): void => {
      chain = chain.then(async () => {
        publishRegistration(await client.refreshPolicy(loadPolicy(config.policyFile)));
        const wasAuthed = client.authenticated;
        const frames = await client.onFrame(data);
        let sent = true;
        for (const frame of frames) if (!send(frame)) { sent = false; break; }
        if (!wasAuthed && client.authenticated && sent) client.registrationSent();
        if (!wasAuthed && client.authenticated) {
          attempt = 0;
          state = { ...state, connectedAt: new Date().toISOString(), disconnectedAt: undefined };
          recordDaemonState(paths, state, log);
          log(`kherep-node: connected as ${config.nodeId}`);
        }
      }).catch((error: unknown) => log(`kherep-node: frame handling failed: ${String(error)}`));
    };
    ws.addEventListener("close", (event) => {
      intakeWindow?.close();
      for (const timer of [ping, snapshots, exchange, directory]) if (timer) clearInterval(timer);
      periodicDiscovery?.abort();
      periodicDiscovery = null;
      client.connectionClosed();
      state = { ...state, disconnectedAt: new Date().toISOString() };
      recordDaemonState(paths, state, log);
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
      stopSweep();
      if (retry) clearTimeout(retry);
      if (socket && socket.readyState <= WebSocket.OPEN) socket.close(1000, "node stopping");
      else finish();
    },
    done,
  };
}

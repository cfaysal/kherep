import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { exportJWK, generateKeyPair, SignJWT, type CryptoKey as JoseKey } from "jose";
import { expect, vi } from "vitest";

// Shared setup of the task tests (issue #31, item 5): an Access stand-in, and
// a node that runs the real node modules (client, session runner, task
// exchange) against a fake claude that never runs anything.
import { NodeClient } from "../../node/client.mts";
import { nodePaths, type NodePaths } from "../../node/config.mts";
import { generateIdentity } from "../../node/identity.mts";
import { DEFAULT_POLICY, type NodePolicy } from "../../node/policy.mts";
import { continueTask, startTask, stopTask, type RunnerDeps } from "../../node/session-runner.mts";
import { parseSessionsPolicy } from "../../node/session-policy.mts";
import { pollTasks, recordRequestResult } from "../../node/task-exchange.mts";
import { watchTasks } from "../../node/task-watch.mts";
import { enroll, FACTS, registry, workerFetch } from "./helpers.mts";

export const WAIT = { timeout: 5_000, interval: 50 };
export const SESSION_ID = "5e550000-0000-4000-8000-000000000001";
const TEAM = "https://team.example.com";
let signingKey: JoseKey | null = null;

// Stand-in for <team domain>/cdn-cgi/access/certs; nothing leaves the test.
export async function installAccess(): Promise<void> {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "test-kid", alg: "RS256", use: "sig" };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    return url === `${TEAM}/cdn-cgi/access/certs` ? Response.json({ keys: [jwk] }) : new Response("unexpected fetch", { status: 599 });
  });
}

export async function api(pathname: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<Response> {
  const jwt = await new SignJWT({ email: "operator@example.com" }).setProtectedHeader({ alg: "RS256", kid: "test-kid" })
    .setIssuer(TEAM).setAudience("test-audience").setIssuedAt().setExpirationTime("5m").sign(signingKey as JoseKey);
  return workerFetch(pathname, { method, headers: { "cf-access-jwt-assertion": jwt, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

export interface TaskNodeOptions { os?: string; sessions?: unknown; runtimes?: string[] }

export async function startTaskNode(name: string, options: TaskNodeOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-task-e2e-"));
  const paths: NodePaths = nodePaths(root);
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const sessions = options.sessions === undefined ? undefined : parseSessionsPolicy({ workspaceRoots: [workspace], ...options.sessions as object });
  const policy: NodePolicy = { ...DEFAULT_POLICY, ...(sessions ? { sessions } : {}) };
  const calls: string[][] = [];
  let agentState = "working";
  const exec = async (_file: string, args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "agents") return JSON.stringify([{ id: "b0000001", sessionId: SESSION_ID, state: agentState }]);
    if (args[0] === "stop") return "";
    return `backgrounded · b0000001 · ${args[args.indexOf("--name") + 1] ?? ""}\n`;
  };
  const runner: RunnerDeps = { paths, policy, exec, findClaude: () => "/opt/bin/claude", platform: "linux", realpath: (p) => path.resolve(p), cli: "kherep-node" };
  const identity = generateIdentity();
  const nodeId = await enroll({ publicKey: identity.publicKey, privateKey: undefined as unknown as CryptoKey }, name);
  const client = new NodeClient({
    nodeId, identity, policy,
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [],
      "session.start": (args) => startTask(args, runner), "session.stop": (args) => stopTask(args, runner),
      "session.continue": (args) => continueTask(args, runner) },
    facts: () => ({ ...FACTS, os: options.os ?? FACTS.os }), runtimes: async () => (options.runtimes ?? ["claude"]).map((r) => ({ name: r, kind: "cli" as const })),
    sessions: async () => [], storeMessage: () => {}, taskRequestResult: (result) => recordRequestResult(paths, result),
  });
  const response = await workerFetch(`/node/connect?nodeId=${nodeId}`, { headers: { upgrade: "websocket" } });
  const ws = response.webSocket!;
  let chain = Promise.resolve();
  const send = (frame: string): boolean => { ws.send(frame); return true; };
  ws.addEventListener("message", (event) => {
    chain = chain.then(async () => { for (const frame of await client.onFrame(event.data as string)) send(frame); });
  });
  ws.accept();
  // Registered, not only authenticated: node selection reads capabilities and runtimes.
  await vi.waitFor(async () => {
    expect(client.authenticated).toBe(true);
    expect((await registry().getNode(nodeId))?.runtimes.length).toBe((options.runtimes ?? ["claude"]).length);
    expect((await registry().getNode(nodeId))?.capabilities.length).toBeGreaterThan(0);
  }, WAIT);
  const inflight = new Set<string>();
  // One exchange round of the daemon: queued task reports and task requests.
  const exchange = async (): Promise<void> => { chain = chain.then(() => pollTasks(client, paths, policy, inflight, send)); await chain; };
  const close = async (): Promise<void> => {
    await chain;
    ws.close(1000, "done");
    fs.rmSync(root, { recursive: true, force: true });
  };
  // Sends frames past the node's own checks, as a modified node could.
  const raw = (frames: string[]): void => { frames.forEach(send); };
  // The daemon's watch round, with the state the fake `claude agents` shows.
  const watch = async (state: string): Promise<void> => { agentState = state; await watchTasks(runner); };
  return { nodeId, client, paths, workspace, calls, exchange, raw, watch, close, idle: () => chain };
}

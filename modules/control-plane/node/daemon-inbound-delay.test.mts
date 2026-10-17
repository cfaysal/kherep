import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import test, { mock } from "node:test";
import { makeEnvelope, parseEnvelope, type SessionInfo } from "../protocol.mts";
import { isMessageStatusBody } from "../protocol-messages.mts";
import { nodePaths, type NodeConfig } from "./config.mts";
import { generateIdentity, writePrivateKey } from "./identity.mts";
import { getMessage } from "./inbox.mts";
import type { ServiceOwnerProbe } from "./service-drain.mts";

const scenarios = ["proof-before-discovery", "proof-after-discovery"] as const;
type Scenario = typeof scenarios[number];
const scenario = process.argv[2] as Scenario | undefined;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
};
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
async function until(predicate: () => boolean, label: string): Promise<void> {
  const timeout = AbortSignal.timeout(5_000);
  while (!predicate()) {
    assert.equal(timeout.aborted, false, `bounded wait failed: ${label}`);
    await turn();
  }
}

if (!scenario) {
  for (const variant of scenarios) test(`independent intake with retained admission: ${variant}`, () => {
    // Module mocks and native-operation guards live only in this subprocess.
    const output = cp.execFileSync(process.execPath, ["--experimental-test-module-mocks", import.meta.filename, variant],
      { encoding: "utf8", timeout: 30_000 });
    assert.match(output, /INBOUND_DELAY_PASS/);
  });
} else {
  assert.ok(scenarios.includes(scenario));
  await characterize(scenario);
}

async function characterize(variant: Scenario): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-inbound-delay-"));
  const paths = nodePaths(root), identity = generateIdentity();
  const events: string[] = [], forbidden: string[] = [], logs: string[] = [];
  const gate = deferred(), proof = deferred();
  const owner = { version: 1 as const, pid: 4242, startedAt: "2026-01-01T00:00:00.000Z", owner: "synthetic" };
  const probe: ServiceOwnerProbe = { current: () => owner, active: () => true };
  let armed = false, entered = false;
  let discoverySignal: AbortSignal | undefined;
  const validDiscovery = () => {
    assert.ok(discoverySignal, "MCP discovery provides an abort signal");
    assert.equal(discoverySignal.aborted, false, "inbound must progress before MCP discovery aborts");
  };
  const old: SessionInfo = { sessionId: "session-old", runtime: "codex", state: "idle" };
  const fresh: SessionInfo = { sessionId: "session-new", runtime: "codex", state: "working" };
  const messageId = "50000000-0000-4000-8000-000000000001";
  const frame = (type: Parameters<typeof makeEnvelope>[0], body: Record<string, unknown>): string =>
    JSON.stringify(makeEnvelope(type, body, 1, 0));
  const original = { ws: globalThis.WebSocket, interval: globalThis.setInterval, clear: globalThis.clearInterval,
    codexHome: process.env.CODEX_HOME };
  const deny = (operation: string): never => { forbidden.push(operation); throw new Error(`FORBIDDEN_NATIVE_OPERATION: ${operation}`); };
  // Never fall back to the operator's home, runtime inventory, process table or network.
  mock.method(os, "homedir", () => root);
  process.env.CODEX_HOME = path.join(root, "codex-home");
  for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"] as const) {
    mock.method(cp, method, () => deny(method));
  }
  mock.method(process, "kill", () => deny("process.kill"));
  mock.method(globalThis, "fetch", () => deny("fetch"));
  syncBuiltinESMExports();
  const sourceModule = await import("./daemon-source.mts");
  mock.module(new URL("./daemon-source.mts", import.meta.url).href, { namedExports: { ...sourceModule,
    captureRuntimeSourceIdentity: () => ({ root, commit: "0".repeat(40), digest: "0".repeat(64), kind: "checkout", verified: true }),
  } });
  const discovery = await import("./discovery.mts");
  mock.module(new URL("./discovery.mts", import.meta.url).href, { namedExports: { ...discovery,
    detectFacts: () => ({ hostname: "synthetic.example.invalid", os: "darwin", arch: "arm64", cpus: 1, memoryBytes: 1024 }),
    discoverRuntimes: async () => [], findOnPath: () => deny("findOnPath"),
  } });
  const { defaultServiceOwnerProbe, withServiceAdmission, retainServiceAdmission, serviceAdmissionsIdle } = await import("./service-drain.mts");
  mock.method(defaultServiceOwnerProbe, "current", probe.current);
  mock.method(defaultServiceOwnerProbe, "active", probe.active);
  const { startDaemon } = await import("./daemon.mts");
  const { enqueueMcpIntent } = await import("./mcp-local.mts");
  const { EXCHANGE_INTERVAL_MS } = await import("./exchange.mts");
  const frames: ReturnType<typeof makeEnvelope>[] = [];
  const timers = new Map<number, (() => void)[]>();
  type Listener = (event: { data?: string; code?: number }) => void;
  let socket!: FakeSocket;
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    listeners = new Map<string, Listener>();
    constructor() { socket = this; }
    addEventListener(name: string, listener: Listener): void { this.listeners.set(name, listener); }
    send(raw: string): void {
      const parsed = parseEnvelope(raw);
      assert.ok(parsed.ok);
      frames.push(parsed.envelope);
      if (parsed.envelope.type === "mcp.intent.register") events.push("intent-published");
      if (parsed.envelope.type === "message.status") {
        assert.ok(isMessageStatusBody(parsed.envelope.body));
        if (parsed.envelope.body.state === "accepted") {
          validDiscovery();
          assert.equal(getMessage(paths.inbox, messageId)?.state, "accepted");
          events.push("stored", "accepted-published");
        }
      }
    }
    close(code = 1000): void { this.readyState = 3; this.listeners.get("close")?.({ code }); }
    receive(raw: string): void { this.listeners.get("message")?.({ data: raw }); }
  }
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  globalThis.setInterval = ((callback: () => void, ms: number) => {
    timers.set(ms, [...timers.get(ms) ?? [], callback]); return { unref() {} };
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  fs.mkdirSync(paths.dir, { recursive: true });
  writePrivateKey(paths.privateKey, identity);
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [], remoteMcp: { enabled: true },
    messaging: { accept: [{ from: ["*"], session: "*" }] } }));
  const config: NodeConfig = { version: 1, controlUrl: "https://control.example.invalid",
    nodeId: "00000000-0000-4000-8000-0000000000aa", name: "synthetic-node", publicKey: identity.publicKey,
    privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: new Date(0).toISOString() };
  const admissionDir = path.join(paths.dir, "service", "admissions");
  const leases = () => fs.readdirSync(admissionDir).sort();
  const acceptedCount = () => frames.filter(f => f.type === "message.status" && isMessageStatusBody(f.body)
    && f.body.messageId === messageId && f.body.state === "accepted").length;
  const storedOnce = () => {
    assert.equal(getMessage(paths.inbox, messageId)?.state, "accepted");
    assert.equal(getMessage(paths.inbox, messageId)?.text, "synthetic message");
    assert.equal(acceptedCount(), 1, "exactly one accepted status is published");
  };
  const unfinished = () => {
    validDiscovery();
    assert.equal(events.includes("discovery-finished"), false);
    assert.equal(events.includes("intent-published"), false);
  };
  const handle = startDaemon(config, paths, line => logs.push(line), async signal => {
    if (!armed) return [old];
    discoverySignal = signal; entered = true; events.push("discovery-entered");
    await gate.promise;
    events.push("discovery-finished");
    return [old, fresh];
  }, async () => deny("runtime probe"));
  try {
    socket.listeners.get("open")?.({});
    socket.receive(frame("event", { name: "auth.ok" }));
    await until(() => frames.some(f => f.type === "sessions.snapshot") && leases().length === 0, "initial discovery finishes");
    await turn(); // Finish initial discovery's publication/finally before arming the next source call.
    frames.length = 0;
    await withServiceAdmission(paths, async admission => retainServiceAdmission(admission, proof.promise), probe);
    assert.equal(leases().length, 1);
    const retained = leases()[0]!;
    armed = true;
    enqueueMcpIntent(paths, { requestId: "40000000-0000-4000-8000-000000000001", runtime: "codex",
      sessionId: fresh.sessionId, callId: "synthetic-call", tool: "status", argumentsDigest: "a".repeat(64) });
    const tick = timers.get(EXCHANGE_INTERVAL_MS)?.[0];
    assert.ok(tick); tick();
    await until(() => entered, "MCP polling enters unresolved-session discovery");
    const discoveryLease = leases().filter(name => name !== retained);
    assert.equal(discoveryLease.length, 1, "held source has a separate active admission");
    validDiscovery();
    events.push("inbound-arrived");
    socket.receive(frame("message.deliver", { messageId, from: { nodeId: config.nodeId, session: "synthetic-peer" },
      toSession: old.sessionId, text: "synthetic message", createdAt: new Date().toISOString() }));
    await until(() => { validDiscovery(); return acceptedCount() > 0; }, "intake progresses during valid discovery");
    storedOnce(); unfinished();
    assert.deepEqual(leases(), [retained, ...discoveryLease].sort(), "both exact admissions survive independent intake");
    assert.equal(serviceAdmissionsIdle(paths, probe), false);
    assert.deepEqual(logs.filter(line => !line.includes("connected as")), []);
    if (variant === "proof-before-discovery") {
      proof.resolve();
      await until(() => !fs.existsSync(path.join(admissionDir, retained)), "only retained lease releases");
      events.push("retained-released");
      assert.deepEqual(leases(), discoveryLease, "discovery admission survives unrelated positive proof");
      storedOnce(); unfinished();
    }
    events.push("discovery-released"); gate.resolve();
    await until(() => events.includes("intent-published") && !fs.existsSync(path.join(admissionDir, discoveryLease[0]!)),
      "MCP intent publishes and its discovery admission releases");
    validDiscovery(); storedOnce();
    if (variant === "proof-after-discovery") {
      assert.deepEqual(leases(), [retained]);
      assert.equal(serviceAdmissionsIdle(paths, probe), false, "discovery completion preserves the unrelated retained lease");
      proof.resolve();
      await until(() => leases().length === 0, "late retained proof releases its lease");
      events.push("retained-released");
    }
    assert.deepEqual(leases(), []);
    assert.equal(serviceAdmissionsIdle(paths, probe), true);
    storedOnce();
    const expected = ["discovery-entered", "inbound-arrived", "stored", "accepted-published",
      ...(variant === "proof-before-discovery" ? ["retained-released"] : []), "discovery-released",
      "discovery-finished", "intent-published", ...(variant === "proof-after-discovery" ? ["retained-released"] : [])];
    assert.deepEqual(events, expected);
    assert.deepEqual(forbidden, [], "no native operation may be swallowed by production error handling");
    assert.deepEqual(logs.filter(line => !line.includes("connected as")), []);
    console.log(`INBOUND_DELAY_PASS ${variant} ${JSON.stringify(events)}`);
  } finally {
    armed = false; gate.resolve(); proof.resolve();
    handle.stop(); await handle.done; await turn();
    globalThis.WebSocket = original.ws;
    globalThis.setInterval = original.interval; globalThis.clearInterval = original.clear;
    if (original.codexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = original.codexHome;
    mock.restoreAll(); syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

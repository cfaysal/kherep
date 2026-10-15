import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { TaskRuntime } from "../protocol-tasks.mts";
import { nodePaths, type NodeConfig, type NodePaths } from "./config.mts";
import { startDaemon } from "./daemon.mts";
import { daemonStateFile, readDaemonState } from "./daemon-state.mts";
import { generateIdentity, writePrivateKey } from "./identity.mts";
import { probeMarkerFile } from "./install-pause.mts";
import type { ProbeResult } from "./runtime-probe.mts";
import { beginServiceDrain } from "./service-drain.mts";

// Issue #420: a stopping daemon waits for its Claude probe instead of leaving
// it to a kill, and a restarted daemon neither probes again within the ready
// TTL nor hides a probe that the previous stop interrupted.

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };
// A gate the probe fake enters and the test opens.
function gate() {
  let enter: () => void = () => {};
  let open: (result: ProbeResult) => void = () => {};
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const opened = new Promise<ProbeResult>((resolve) => { open = resolve; });
  return { entered, open, probe: (): Promise<ProbeResult> => { enter(); return opened; } };
}

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  readyState = FakeWebSocket.CONNECTING;
  private readonly listeners = new Map<string, ((event: { code: number }) => void)[]>();
  addEventListener(type: string, listener: (event: { code: number }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(): void {}
  close(code = 1000): void {
    this.readyState = 3;
    for (const listener of this.listeners.get("close") ?? []) listener({ code });
  }
}

function fixture(t: test.TestContext): { paths: NodePaths; start: (probe: (runtime: TaskRuntime) => Promise<ProbeResult>) => {
  handle: ReturnType<typeof startDaemon>; logs: string[]; }; } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-daemon-stop-probe-"));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  const identity = generateIdentity();
  writePrivateKey(paths.privateKey, identity);
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [],
    sessions: { enabled: true, workspaceRoots: [root], runtimes: ["claude"] } }));
  const config: NodeConfig = { version: 1, controlUrl: "https://control.example.invalid", nodeId: "00000000-0000-4000-8000-0000000000aa",
    name: "synthetic-node", publicKey: identity.publicKey, privateKeyFile: paths.privateKey, policyFile: paths.policy,
    enrolledAt: new Date(0).toISOString() };
  const original = globalThis.WebSocket;
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: FakeWebSocket });
  const handles: ReturnType<typeof startDaemon>[] = [];
  t.after(async () => {
    for (const handle of handles) { handle.stop(); await handle.done; }
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: original });
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { paths, start: (probe) => {
    const logs: string[] = [];
    const handle = startDaemon(config, paths, (line) => logs.push(line), undefined, probe);
    handles.push(handle);
    return { handle, logs };
  } };
}

test("stop waits for the Claude probe in flight, which removes its marker", async (t) => {
  const f = fixture(t);
  const g = gate();
  const { handle, logs } = f.start(g.probe);
  await g.entered;
  assert.equal(fs.existsSync(probeMarkerFile(f.paths)), true, "the probe runs");
  handle.stop();
  assert.equal(await Promise.race([handle.done.then(() => true), wait(200).then(() => false)]), false, "done waits for the probe");
  g.open({ ok: true });
  await handle.done;
  assert.equal(fs.existsSync(probeMarkerFile(f.paths)), false, "nothing for the next daemon to report");
  assert.ok(logs.includes("kherep-node: stopping; waiting for the claude probe to finish, at most 50 s"), logs.join("\n"));
  assert.equal(readDaemonState(f.paths)?.readiness?.claude?.ready, true, "its verdict is kept for the next start");
});

test("a probe still waiting for a service drain does not hold the stop and records nothing", async (t) => {
  const f = fixture(t);
  const endDrain = beginServiceDrain(f.paths);
  const probes: TaskRuntime[] = [];
  const { handle } = f.start(async (runtime) => { probes.push(runtime); return { ok: true }; });
  await wait(50);
  handle.stop();
  assert.equal(await Promise.race([handle.done.then(() => true), wait(500).then(() => false)]), true);
  assert.deepEqual(probes, []);
  assert.equal(readDaemonState(f.paths)?.readiness, undefined);
  endDrain();
});

test("a restart within the ready TTL advertises the previous ready verdict without a probe", async (t) => {
  const f = fixture(t);
  const claude = { ready: true, probedAt: new Date(Date.now() - 5 * 60_000).toISOString() };
  fs.writeFileSync(daemonStateFile(f.paths), JSON.stringify({ pid: 1, startedAt: new Date(0).toISOString(), readiness: { claude } }));
  const probes: TaskRuntime[] = [];
  f.start(async (runtime) => { probes.push(runtime); return { ok: true }; });
  await flush();
  assert.deepEqual(probes, [], "no start-up probe");
  assert.deepEqual(readDaemonState(f.paths)?.readiness, { claude }, "the carried verdict keeps its probe time");
});

test("a marker the previous daemon left forces the start-up probe and stays on record until it is ready", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(daemonStateFile(f.paths), JSON.stringify({ pid: 1, startedAt: new Date(0).toISOString(),
    readiness: { claude: { ready: true, probedAt: new Date(Date.now() - 60_000).toISOString() } } }));
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  fs.writeFileSync(probeMarkerFile(f.paths), `${dead} 2026-10-15T08:00:00.000Z\n`);
  const g = gate();
  const { logs } = f.start(g.probe);
  await g.entered;
  // Reaching the gate means it was probed despite the fresh ready verdict.
  assert.ok(logs[0]?.startsWith(`kherep-node: the previous daemon stop interrupted a claude probe (daemon pid ${dead}, `), logs.join("\n"));
  const recorded = readDaemonState(f.paths);
  assert.deepEqual([recorded?.interruptedProbe?.pid, recorded?.interruptedProbe?.at], [dead, "2026-10-15T08:00:00.000Z"]);
  assert.equal(recorded?.readiness, undefined, "the old verdict is not advertised");
  g.open({ ok: true });
  await flush();
  assert.equal(readDaemonState(f.paths)?.interruptedProbe, undefined, "cleared by the ready verdict");
});

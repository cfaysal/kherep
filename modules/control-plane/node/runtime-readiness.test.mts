import assert from "node:assert/strict";
import test from "node:test";

import { isRegisterBody, makeEnvelope, parseEnvelope, type Envelope } from "../protocol.mts";
import { RUNTIME_READY_CAPABILITIES, type TaskRuntime } from "../protocol-tasks.mts";
import { NodeClient } from "./client.mts";
import { generateIdentity } from "./identity.mts";
import { advertisedCapabilities, type NodePolicy } from "./policy.mts";
import type { ProbeResult } from "./runtime-probe.mts";
import {
  createReadiness, NOT_READY_TTL_MS, notReady, notReadyNow, notReadyReason, READY_TTL_MS,
} from "./runtime-readiness.mts";

// Issue #197: the readiness verdict is cached (ready 10 min, not ready 2 min),
// one probe per runtime runs at a time, and nothing probes on its own.

function counted(results: ProbeResult[]) {
  const probes: TaskRuntime[] = [];
  let release: (() => void) | null = null;
  let hold = false;
  const probe = async (runtime: TaskRuntime): Promise<ProbeResult> => {
    probes.push(runtime);
    if (hold) await new Promise<void>((resolve) => { release = resolve; });
    return results.length > 1 ? results.shift()! : results[0];
  };
  return { probes, probe, holdNext: () => { hold = true; }, release: () => { hold = false; release?.(); } };
}
const SIGN_IN: ProbeResult = { ok: false, cause: "sign-in", detail: "Login expired" };

test("a ready verdict is reused for 10 minutes, a failed one for 2; then the next run probes again", async () => {
  let clock = 0;
  const p = counted([{ ok: true }, SIGN_IN, { ok: true }]);
  const readiness = createReadiness(p.probe, { now: () => clock });
  assert.equal(await notReady(readiness, "claude"), null);
  clock += READY_TTL_MS - 1;
  assert.equal(await notReady(readiness, "claude"), null);
  assert.equal(p.probes.length, 1, "cached");
  clock += 1;
  assert.equal(await notReady(readiness, "claude"), "target runtime claude not ready (sign-in required)");
  clock += NOT_READY_TTL_MS - 1;
  assert.equal(await notReady(readiness, "claude"), "target runtime claude not ready (sign-in required)");
  assert.equal(p.probes.length, 2);
  clock += 1;
  assert.equal(await notReady(readiness, "claude"), null, "signed in again: recovered after 2 minutes");
  assert.deepEqual(p.probes, ["claude", "claude", "claude"]);
});

test("concurrent runs share one probe; a round does not wait for it", async () => {
  const p = counted([{ ok: true }]);
  p.holdNext();
  const readiness = createReadiness(p.probe);
  assert.equal(notReadyNow(readiness, "codex"), "pending", "no verdict yet: the round leaves the messages waiting");
  const waiting = [notReady(readiness, "codex"), notReady(readiness, "codex")];
  assert.equal(notReadyNow(readiness, "codex"), "pending");
  p.release();
  assert.deepEqual(await Promise.all(waiting), [null, null]);
  assert.equal(notReadyNow(readiness, "codex"), null);
  assert.equal(p.probes.length, 1);
});

test("a throwing probe is not ready; invalidate probes again but keeps what is advertised until then", async () => {
  let fail = true;
  const readiness = createReadiness(async () => {
    if (fail) throw new Error("spawn EACCES");
    return { ok: true };
  });
  assert.equal(await notReady(readiness, "claude"), notReadyReason("claude", "error"));
  assert.deepEqual(readiness.ready(), []);
  fail = false;
  readiness.invalidate("claude");
  assert.equal(await notReady(readiness, "claude"), null);
  assert.deepEqual(readiness.ready(), ["claude"]);
  fail = true;
  readiness.invalidate("claude");
  assert.deepEqual(readiness.ready(), ["claude"], "still advertised until the next probe");
  assert.equal(await notReady(readiness, "claude"), "target runtime claude not ready (probe failed)");
  assert.deepEqual(readiness.ready(), []);
  assert.equal(await notReady(undefined, "claude"), null, "without a readiness every runtime counts as ready");
  assert.equal(notReadyReason("codex", "timeout"), "target runtime codex not ready (probe timed out)");
});

const SESSIONS: NodePolicy = { version: 1, allowedCommands: [], sessions: {
  enabled: true, workspaceRoots: ["/w"], runtimes: ["claude"], permissionModes: ["auto"], defaultPermissionMode: "auto",
  maxConcurrent: 3, maxStartsPerDay: 10, maxRuntimeMinutes: 120, delegate: { request: false, accept: false }, ownTaskControl: false } };

test("ready runtimes are advertised as opaque capabilities an existing Worker accepts, only for enabled runtimes", () => {
  const caps = advertisedCapabilities(SESSIONS, ["claude", "codex"]);
  assert.ok(caps.includes(RUNTIME_READY_CAPABILITIES.claude));
  assert.ok(!caps.includes(RUNTIME_READY_CAPABILITIES.codex), "codex is not enabled");
  assert.deepEqual(advertisedCapabilities(SESSIONS), caps.filter((c) => c !== RUNTIME_READY_CAPABILITIES.claude), "unchanged without a verdict");
  // The Worker validates register bodies with this function; capability strings are opaque there.
  assert.equal(isRegisterBody({ facts: { hostname: "h", os: "linux", arch: "x64", cpus: 1, memoryBytes: 1 }, runtimes: [], capabilities: caps }), true);
});

test("a changed verdict re-registers the node once with the new capability", async () => {
  let ready: TaskRuntime[] = [];
  const client = new NodeClient({
    nodeId: "00000000-0000-4000-8000-0000000000aa", identity: generateIdentity(), policy: SESSIONS,
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [] },
    facts: () => ({ hostname: "h", os: "linux", arch: "x64", cpus: 1, memoryBytes: 1 }), runtimes: async () => [],
    sessions: async () => [], storeMessage: () => {}, readyRuntimes: () => ready,
  });
  const decode = (frames: string[]): Envelope[] => frames.map((f) => { const p = parseEnvelope(f); assert.ok(p.ok); return p.envelope; });
  await client.onFrame(JSON.stringify(makeEnvelope("challenge", { nonce: "bm9uY2U", serverTime: 0 }, 0, 0)));
  const first = decode(await client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0))))[0];
  assert.ok(!(first.body as { capabilities: string[] }).capabilities.includes(RUNTIME_READY_CAPABILITIES.claude));
  client.registrationSent();
  assert.deepEqual(await client.refreshPolicy(SESSIONS), [], "nothing changed");
  ready = ["claude"];
  const again = decode(await client.refreshPolicy(SESSIONS));
  assert.deepEqual(again.map((e) => e.type), ["register"]);
  assert.ok((again[0].body as { capabilities: string[] }).capabilities.includes(RUNTIME_READY_CAPABILITIES.claude));
  client.registrationSent();
  assert.deepEqual(await client.refreshPolicy(SESSIONS), [], "once");
});

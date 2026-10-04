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

// Issue #197: a verdict is used stale while it revalidates in the background
// (ready after 10 min, not ready after 2), only a runtime without any verdict
// waits, one probe per runtime runs at a time, and only sign-in blocks a run.

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
const settle = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

test("an aged verdict is still used at once and revalidated in the background: ready after 10 minutes, not ready after 2", async () => {
  let clock = 0;
  const p = counted([{ ok: true }, SIGN_IN, { ok: true }]);
  const readiness = createReadiness(p.probe, { now: () => clock });
  assert.equal(await notReady(readiness, "claude"), null, "the first verdict is awaited");
  clock += READY_TTL_MS - 1;
  assert.equal(await notReady(readiness, "claude"), null);
  assert.equal(p.probes.length, 1, "cached");
  clock += 1;
  assert.equal(await notReady(readiness, "claude"), null, "aged: the old verdict answers without waiting");
  await settle();
  assert.equal(p.probes.length, 2, "and a probe ran in the background");
  assert.equal(await notReady(readiness, "claude"), "target runtime claude not ready (sign-in required)");
  clock += NOT_READY_TTL_MS - 1;
  readiness.revalidate("claude");
  assert.equal(notReadyNow(readiness, "claude"), "target runtime claude not ready (sign-in required)");
  assert.equal(p.probes.length, 2, "not aged: no probe");
  clock += 1;
  readiness.revalidate("claude");
  await settle();
  assert.equal(p.probes.length, 3, "the watch round revalidates an aged not-ready verdict");
  assert.equal(notReadyNow(readiness, "claude"), null, "signed in again: recovered");
  clock += READY_TTL_MS;
  readiness.revalidate("claude");
  await settle();
  assert.equal(p.probes.length, 3, "revalidate never probes a ready runtime");
});

test("only a runtime without any verdict waits; concurrent callers share one probe; a round never waits", async () => {
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

test("only sign-in blocks: after a timeout or another probe failure a task proceeds and messages wait", async () => {
  for (const cause of ["timeout", "error"] as const) {
    const readiness = createReadiness(async () => ({ ok: false, cause, detail: "" }));
    assert.equal(await notReady(readiness, "codex"), null, `${cause}: the task runs; its CLI error and the inactivity bound still apply`);
    assert.equal(notReadyNow(readiness, "codex"), "pending", `${cause}: messages wait with retry-pending`);
    assert.deepEqual(readiness.ready(), [], `${cause}: not advertised`);
  }
  const signIn = createReadiness(async () => SIGN_IN);
  assert.equal(await notReady(signIn, "codex"), "target runtime codex not ready (sign-in required)");
  assert.equal(notReadyNow(signIn, "codex"), "target runtime codex not ready (sign-in required)");
});

test("a throwing probe is not ready; invalidate probes again but keeps what is advertised until then", async () => {
  let fail = true;
  const readiness = createReadiness(async () => {
    if (fail) throw new Error("spawn EACCES");
    return { ok: true };
  });
  const verdict = await readiness.check("claude");
  assert.equal(!verdict.ready && verdict.cause, "error");
  assert.deepEqual(readiness.ready(), []);
  fail = false;
  readiness.invalidate("claude");
  readiness.peek("claude");
  await settle();
  assert.deepEqual(readiness.ready(), ["claude"]);
  fail = true;
  readiness.invalidate("claude");
  assert.deepEqual(readiness.ready(), ["claude"], "still advertised until the next probe");
  readiness.peek("claude");
  await settle();
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

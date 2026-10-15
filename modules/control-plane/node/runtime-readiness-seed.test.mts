import assert from "node:assert/strict";
import test from "node:test";

import type { TaskRuntime } from "../protocol-tasks.mts";
import type { ProbeResult } from "./runtime-probe.mts";
import { createReadiness, READY_TTL_MS, type Verdict } from "./runtime-readiness.mts";

// Issue #420: a restarted daemon uses the previous daemon's fresh ready verdict
// instead of a start-up probe, and a stopping daemon starts no probe and waits
// for the ones in flight.

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const settle = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });
const record = (ready: boolean, ageMs: number) => ({ ready, probedAt: new Date(NOW - ageMs).toISOString() });

function probes(delayMs = 0, result: ProbeResult = { ok: true }) {
  const calls: TaskRuntime[] = [];
  const probe = async (runtime: TaskRuntime): Promise<ProbeResult> => {
    calls.push(runtime);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return result;
  };
  return { calls, probe };
}

test("a ready verdict younger than READY_TTL_MS is used without a probe", async () => {
  const p = probes();
  const readiness = createReadiness(p.probe, { now: () => NOW, seed: { claude: record(true, 5 * 60_000) } });
  assert.deepEqual(readiness.peek("claude"), { ready: true, at: NOW - 5 * 60_000 });
  assert.deepEqual(await readiness.check("claude"), { ready: true, at: NOW - 5 * 60_000 });
  assert.deepEqual(readiness.ready(), ["claude"], "advertised");
  await settle();
  assert.deepEqual(p.calls, [], "no start-up probe");
});

test("an aged, not-ready, future, malformed or foreign seed is ignored and the runtime is probed", async () => {
  for (const seed of [
    { claude: record(true, READY_TTL_MS + 60_000) },
    { claude: { ...record(false, 60_000), cause: "sign-in" } },
    { claude: record(true, -60_000) },
    { claude: { ready: true, probedAt: "yesterday" } },
    { claude: "ready" },
  ]) {
    const p = probes();
    const readiness = createReadiness(p.probe, { now: () => NOW, seed });
    assert.equal(readiness.peek("claude"), null, JSON.stringify(seed));
    await settle();
    assert.deepEqual(p.calls, ["claude"], JSON.stringify(seed));
  }
  const readiness = createReadiness(probes().probe, { now: () => NOW, seed: { foreign: record(true, 0) } });
  assert.deepEqual(readiness.ready(), [], "only task runtimes are seeded");
});

test("stop waits for the probe in flight and starts no probe afterwards", async () => {
  const p = probes(200);
  const logs: string[] = [];
  const verdicts: Verdict[] = [];
  const readiness = createReadiness(p.probe, { log: (line) => logs.push(line), onVerdict: (_, verdict) => verdicts.push(verdict) });
  void readiness.check("claude");
  const started = Date.now();
  await readiness.stop();
  assert.ok(Date.now() - started >= 150, "resolved only after the probe settled");
  assert.equal(verdicts.length, 1, "the completed probe's verdict is still recorded");
  assert.ok(logs.includes("kherep-node: stopping; waiting for the claude probe to finish, about 50 s"));
  readiness.invalidate("claude");
  readiness.peek("claude");
  readiness.revalidate("codex");
  await readiness.check("codex");
  await settle();
  assert.deepEqual(p.calls, ["claude"], "no probe after stop");
});

test("stop with nothing in flight resolves at once and logs nothing; a probe that fails while stopping records nothing", async () => {
  const logs: string[] = [];
  const idle = createReadiness(probes().probe, { log: (line) => logs.push(line) });
  await idle.stop();
  assert.deepEqual(logs, []);
  let reject: (error: Error) => void = () => {};
  const verdicts: Verdict[] = [];
  const readiness = createReadiness(() => new Promise<ProbeResult>((_, fail) => { reject = fail; }),
    { onVerdict: (_, verdict) => verdicts.push(verdict) });
  const pending = readiness.check("claude");
  const stopped = readiness.stop();
  reject(new Error("operation aborted"));
  await stopped;
  assert.deepEqual(verdicts, [], "an aborted probe is not a verdict");
  assert.equal(readiness.peek("claude"), null);
  assert.equal((await pending).ready, false);
});

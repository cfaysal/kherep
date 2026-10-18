import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import test from "node:test";

import type { SignalScope } from "./codex-process.mts";
import { terminate } from "./codex-stop.mts";
import { held } from "./process-start.mts";

// Issue #473: an awaited start read lets the exit of the held root be handled,
// and its handle closed, before the read resolves with the old start. A stop
// binds to the child held at entry and signals the root only while that same
// child is still held after the read.
const ROOT = 40_101;
type Sent = [number, NodeJS.Signals, SignalScope | undefined];
type Interleave = (pid: number) => void;
const interleavings: [string, Interleave, string | null][] = [
  ["lost", (pid) => { held.delete(pid); }, null],
  ["replaced-held", (pid) => { held.set(pid, {} as ChildProcess); }, "replacement"],
];
const timesOut = (): never => {
  throw Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT" });
};

// The signals are checked before the message, so a wrong send is what fails.
const rejection = (stop: Promise<void>): Promise<Error> => stop.then(() => assert.fail("the stop resolved"), (error: Error) => error);

// Read number raceOn ends or replaces the held child during the read and still
// answers the old start; later reads answer what the pid is by then.
function racingStart(interleave: Interleave, raceOn: number, later: string | null) {
  let calls = 0;
  return async (pid: number): Promise<string | null> => {
    calls += 1;
    if (calls < raceOn) return "root-start";
    if (calls > raceOn) return later;
    await Promise.resolve();
    interleave(pid);
    return "root-start";
  };
}

function holdOriginal(t: { after: (fn: () => void) => void }): ChildProcess {
  const original = {} as ChildProcess;
  held.set(ROOT, original);
  t.after(() => held.delete(ROOT));
  return original;
}

for (const [name, interleave, later] of interleavings) {
  for (const [label, pidStart] of [["T-P1a without a start time", undefined], ["T-P1b with a recorded start", "root-start"]] as const) {
    test(`${label}: a held root ${name} during its SIGTERM read gets no signal and the stop resolves (issue #473)`, async (t) => {
      holdOriginal(t);
      const signals: Sent[] = [];
      await terminate({ graceMs: 1, processTree: () => [{ pid: ROOT, start: "root-start" }],
        processStart: racingStart(interleave, 1, later),
        signal: (pid, signal, scope) => { signals.push([pid, signal, scope]); } }, ROOT, pidStart);
      assert.deepEqual(signals, []);
    });
  }

  test(`T-P1c: after a timeout a held root ${name} during the fallback read is not forced (issue #473)`, async (t) => {
    holdOriginal(t);
    const signals: Sent[] = [];
    // read 1 is the capture's root read; the relations time out; read 2 is the fallback's
    const error = await rejection(terminate({ processRelations: timesOut, processStart: racingStart(interleave, 2, later),
      signal: (pid, signal, scope) => { signals.push([pid, signal, scope]); } }, ROOT, "root-start"));
    assert.deepEqual(signals, []);
    assert.match(error.message, /ETIMEDOUT; the root is no longer the recorded process, so nothing was forced/);
  });

  test(`T-P1d: a held root ${name} after SIGTERM gets no SIGKILL (issue #473)`, async (t) => {
    holdOriginal(t);
    const signals: Sent[] = [];
    let raced = false;
    // after SIGTERM every read answers the old start, so no wait confirms
    const processStart = async (pid: number): Promise<string | null> => {
      if (signals.length > 0 && !raced) {
        raced = true;
        await Promise.resolve();
        interleave(pid);
      }
      return "root-start";
    };
    const error = await rejection(terminate({ graceMs: 1, processTree: () => [{ pid: ROOT, start: "root-start" }], processStart,
      signal: (pid, signal, scope) => { signals.push([pid, signal, scope]); } }, ROOT, "root-start"));
    assert.deepEqual(signals, [[ROOT, "SIGTERM", "group"]]);
    assert.match(error.message, /did not stop after SIGKILL; the held root ended during its start read before SIGKILL/);
  });
}

for (const pidStart of [undefined, "root-start"]) {
  test(`T-P1e: an unchanged held root gets its signal after an awaited read (start ${pidStart ?? "unknown"}, issue #473)`, async (t) => {
    const original = holdOriginal(t);
    const signals: Sent[] = [];
    let alive = true;
    await terminate({ graceMs: 1, processTree: () => [{ pid: ROOT, start: "root-start" }],
      processStart: async () => { await Promise.resolve(); return alive ? "root-start" : null; },
      signal: (pid, signal, scope) => { signals.push([pid, signal, scope]); alive = false; } }, ROOT, pidStart);
    assert.deepEqual(signals, [[ROOT, "SIGTERM", "group"]]);
    assert.equal(held.get(ROOT), original);
  });
}

import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import test from "node:test";

import type { SignalScope } from "./codex-process.mts";
import { processTree, terminate, windowsRelations, type ProcessIdentity } from "./codex-stop.mts";
import { held } from "./process-start.mts";

const ROOT = 40_001;
const CHILD = 40_002;
const TREE: ProcessIdentity[] = [{ pid: ROOT, start: "root-start" }, { pid: CHILD, start: "child-start" }];
type Sent = [number, NodeJS.Signals, SignalScope | undefined];

test("termination confirms every captured pid start identity before returning", async () => {
  const starts = new Map(TREE.map((entry) => [entry.pid, entry.start]));
  const signals: Sent[] = [];
  await terminate({ processTree: () => TREE, processStart: (pid) => starts.get(pid) ?? null, graceMs: 1,
    signal: (pid, signal, scope) => {
      signals.push([pid, signal, scope]);
      if (signal === "SIGKILL") starts.clear();
    } }, ROOT, "root-start");
  assert.deepEqual(signals, [[ROOT, "SIGTERM", "group"], [CHILD, "SIGTERM", "process"], [ROOT, "SIGKILL", "group"]]);
  assert.deepEqual([...starts], []);
});

// Issue #473: with an awaited start-time read, each signal still follows the
// read of its own pid's start directly; nothing runs between them.
test("an asynchronous start-time read keeps every signal right after the read of its pid", async () => {
  const starts = new Map(TREE.map((entry) => [entry.pid, entry.start]));
  const events: string[] = [];
  const signals: Sent[] = [];
  await terminate({ processTree: () => TREE, graceMs: 1,
    processStart: (pid) => new Promise((resolve) => setImmediate(() => { events.push(`read ${pid}`); resolve(starts.get(pid) ?? null); })),
    signal: (pid, signal, scope) => {
      events.push(`signal ${pid}`);
      signals.push([pid, signal, scope]);
      if (signal === "SIGKILL") starts.clear();
    } }, ROOT, "root-start");
  assert.deepEqual(signals, [[ROOT, "SIGTERM", "group"], [CHILD, "SIGTERM", "process"], [ROOT, "SIGKILL", "group"]]);
  events.forEach((event, i) => {
    if (event.startsWith("signal ")) assert.equal(events[i - 1], event.replace("signal", "read"), `read before ${event}`);
  });
});

test("Windows process discovery captures the root and every descendant identity", async () => {
  const starts = new Map([[ROOT, "root-start"], [CHILD, "child-start"], [40_003, "grandchild-start"], [40_004, "unrelated-start"]]);
  const relations = [{ pid: CHILD, ppid: ROOT }, { pid: 40_003, ppid: CHILD }, { pid: 40_004, ppid: 10 }];
  assert.deepEqual(await processTree({ platform: "win32", processStart: (pid) => starts.get(pid) ?? null,
    processRelations: () => relations }, ROOT), TREE.concat({ pid: 40_003, start: "grandchild-start" }));
  assert.deepEqual(await processTree({ platform: "win32", processStart: (pid) => starts.get(pid) ?? null,
    processRelations: () => [] }, ROOT), [TREE[0]]);
});

test("a reused root pid during grace is not signalled again; its verified child is, by pid", async () => {
  const starts = new Map(TREE.map((entry) => [entry.pid, entry.start]));
  const signals: Sent[] = [];
  await assert.rejects(terminate({ processTree: () => TREE, processStart: (pid) => starts.get(pid) ?? null, graceMs: 1,
    signal: (pid, signal, scope) => {
      signals.push([pid, signal, scope]);
      starts.set(ROOT, "reused-root");
    } }, ROOT, "root-start"), /did not stop after SIGKILL; root process was reused before SIGKILL/);
  assert.deepEqual(signals, [[ROOT, "SIGTERM", "group"], [CHILD, "SIGTERM", "process"], [CHILD, "SIGKILL", "process"]]);
  assert.equal(starts.get(CHILD), "child-start");
});

test("an orphaned captured child that cannot be stopped prevents false stop confirmation", async () => {
  const starts = new Map(TREE.map((entry) => [entry.pid, entry.start]));
  const signals: Sent[] = [];
  await assert.rejects(terminate({ platform: "win32", processTree: () => TREE,
    processStart: (pid) => starts.get(pid) ?? null, graceMs: 1,
    signal: (pid, signal, scope) => {
      signals.push([pid, signal, scope]);
      starts.delete(ROOT);
      if (pid === CHILD && signal === "SIGKILL") throw new Error("Access is denied.");
    } }, ROOT, "root-start"),
  /did not stop after SIGKILL; root process ended before SIGKILL; SIGKILL to pid 40002 failed: Access is denied\./);
  assert.deepEqual(signals, [[ROOT, "SIGTERM", "group"], [CHILD, "SIGTERM", "process"], [CHILD, "SIGKILL", "process"]]);
  assert.equal(starts.get(CHILD), "child-start");
});

// Issue #231: Codex runs shell commands in their own process group, so the
// signal to the root's group misses them, and the root can end first.
test("a descendant outside the root's group is stopped by pid after the group signal (issue #231)", async () => {
  const starts = new Map(TREE.map((entry) => [entry.pid, entry.start]));
  const signals: Sent[] = [];
  await terminate({ processTree: () => TREE, processStart: (pid) => starts.get(pid) ?? null, graceMs: 1,
    signal: (pid, signal, scope) => {
      signals.push([pid, signal, scope]);
      starts.delete(pid); // the group signal reaches the root only
    } }, ROOT, "root-start");
  assert.deepEqual(signals, [[ROOT, "SIGTERM", "group"], [CHILD, "SIGTERM", "process"]]);
  assert.equal(starts.size, 0);
});

test("a root that ended before SIGKILL leaves its verified descendant to SIGKILL by pid (issue #231)", async () => {
  const starts = new Map(TREE.map((entry) => [entry.pid, entry.start]));
  const signals: Sent[] = [];
  await terminate({ processTree: () => TREE, processStart: (pid) => starts.get(pid) ?? null, graceMs: 1,
    signal: (pid, signal, scope) => {
      signals.push([pid, signal, scope]);
      if (pid === ROOT || signal === "SIGKILL") starts.delete(pid); // the child ignores SIGTERM
    } }, ROOT, "root-start");
  assert.deepEqual(signals, [[ROOT, "SIGTERM", "group"], [CHILD, "SIGTERM", "process"], [CHILD, "SIGKILL", "process"]]);
  assert.equal(starts.size, 0);
});

test("a captured descendant pid that was reused is never signalled (issue #231)", async () => {
  const starts = new Map(TREE.map((entry) => [entry.pid, entry.start]));
  const signals: Sent[] = [];
  await terminate({ processTree: () => TREE, processStart: (pid) => starts.get(pid) ?? null, graceMs: 1,
    signal: (pid, signal, scope) => {
      signals.push([pid, signal, scope]);
      starts.delete(ROOT);
      starts.set(CHILD, "reused-child"); // the child ended and its pid now names another process
    } }, ROOT, "root-start");
  assert.deepEqual(signals, [[ROOT, "SIGTERM", "group"]]);
  assert.equal(starts.get(CHILD), "reused-child");
});

test("a tree that survives SIGKILL rejects instead of confirming a stop", async () => {
  await assert.rejects(terminate({ processTree: () => TREE, processStart: (pid) => TREE.find((entry) => entry.pid === pid)?.start ?? null,
    graceMs: 1, signal: () => {} }, ROOT, "root-start"), /did not stop after SIGKILL/);
});

test("a root lost during capture cannot hide a surviving descendant", async () => {
  const signals: NodeJS.Signals[] = [];
  await assert.rejects(terminate({ processTree: () => [TREE[1]],
    processStart: (pid) => pid === CHILD ? "child-start" : null,
    signal: (_pid, signal) => { signals.push(signal); } }, ROOT, "root-start"),
  /root process identity changed during capture/);
  assert.deepEqual(signals, []);
});

// A root reused during the capture, after its first read (the fake stands for that).
test("a reused root seen during capture is not accepted as a stopped tree", async () => {
  const signals: NodeJS.Signals[] = [];
  await assert.rejects(terminate({ processTree: () => [{ pid: ROOT, start: "reused-root" }, TREE[1]],
    processStart: (pid) => pid === ROOT ? "reused-root" : "child-start",
    signal: (_pid, signal) => { signals.push(signal); } }, ROOT, "root-start"),
  /root process identity changed during capture/);
  assert.deepEqual(signals, []);
});

test("a missing root with ended captured descendants needs no signal", async () => {
  await terminate({ processTree: () => [TREE[1]], processStart: () => null,
    signal: () => { assert.fail("an ended tree must not be signalled"); } }, ROOT, "root-start");
});

// Issue #544: a root that no longer has its recorded start before the capture
// (its pid reused after a reboot) owns no tree of the run; nothing under it is
// listed, read or signalled, as for a pid without a process.
for (const [name, rootStart] of [["reused", "reused-root"], ["free", null]] as const) {
  test(`a root ${name} before the capture is treated as ended: its tree is not listed, nothing is signalled (issue #544)`, async () => {
    const reads: number[] = [];
    let listed = 0;
    await terminate({ processStart: (pid) => { reads.push(pid); return pid === ROOT ? rootStart : null; },
      processRelations: () => { listed += 1; return [{ pid: CHILD, ppid: ROOT }]; },
      signal: () => { assert.fail("a foreign tree must not be signalled"); } }, ROOT, "root-start");
    assert.deepEqual([reads, listed], [[ROOT], 0]);
  });
}

// The runner's error when its timeout ended the child (issue #221; child-run.mts).
const timeout = () => Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT" });
const timesOut = (): never => { throw timeout(); };

test("a timed-out Windows process-tree query runs once more; any other failure and a second timeout throw (issue #221)", async () => {
  let calls = 0;
  assert.deepEqual(await windowsRelations(async () => {
    calls += 1;
    return calls === 1 ? timesOut() : `${CHILD} ${ROOT}\r\n`;
  }), [{ pid: CHILD, ppid: ROOT }]);
  assert.equal(calls, 2);
  for (const [error, expected] of [[timeout(), 2], [new Error("Add-Type failed"), 1]] as const) {
    calls = 0;
    await assert.rejects(windowsRelations(async () => { calls += 1; throw error; }), error);
    assert.equal(calls, expected);
  }
});

test("a capture that timed out forces the verified root's tree and still fails the stop (issue #221)", async () => {
  const starts = new Map(TREE.map((entry) => [entry.pid, entry.start]));
  const signals: NodeJS.Signals[] = [];
  await assert.rejects(terminate({ processRelations: timesOut, processStart: (pid) => starts.get(pid) ?? null,
    signal: (_pid, signal) => {
      signals.push(signal);
      starts.clear();
    } }, ROOT, "root-start"), /ETIMEDOUT; its process tree was forced to stop, the stop is not confirmed/);
  assert.deepEqual(signals, ["SIGKILL"]);
  assert.equal(starts.size, 0);
});

test("after a timeout only the recorded root is forced, and a failed force is reported (issue #221)", async () => {
  const signals: NodeJS.Signals[] = [];
  const signal = (_pid: number, sent: NodeJS.Signals) => { signals.push(sent); };
  // The root is the recorded process at the capture's first read and reused by the re-read after the timeout.
  let rootReads = 0;
  const reusedAfterCapture = () => (rootReads++ === 0 ? "root-start" : "reused-root");
  await assert.rejects(terminate({ processRelations: timesOut, processStart: reusedAfterCapture, signal }, ROOT, "root-start"),
    /ETIMEDOUT; the root is no longer the recorded process, so nothing was forced/);
  await assert.rejects(terminate({ processRelations: () => { throw new Error("Add-Type failed"); },
    processStart: () => "root-start", signal }, ROOT, "root-start"), /^Error: Add-Type failed$/);
  assert.deepEqual(signals, []);
  await assert.rejects(terminate({ processRelations: timesOut, processStart: () => "root-start",
    signal: () => { throw new Error("could not send SIGKILL to process tree"); } }, ROOT, "root-start"),
  /ETIMEDOUT; forcing its process tree failed: could not send SIGKILL to process tree/);
});

// Issue #473: with the identity reads awaited, the held child of a run without
// a start time can end (lost) or its pid be held by a new child (replaced)
// during the capture or a timed-out read; a start read then is a foreign one.
type Interleave = (pid: number) => void;
const interleavings: [string, Interleave][] = [
  ["lost", (pid) => { held.delete(pid); }],
  ["replaced-held", (pid) => { held.set(pid, {} as ChildProcess); }],
];

for (const [name, interleave] of interleavings) {
  test(`a held child ${name} during capture is never signalled (issue #473)`, async (t) => {
    held.set(ROOT, {} as ChildProcess);
    t.after(() => held.delete(ROOT));
    const signals: Sent[] = [];
    await assert.rejects(terminate({ graceMs: 1, processStart: () => "replacement",
      processTree: async (root) => { await Promise.resolve(); interleave(root); return [{ pid: ROOT, start: "replacement" }]; },
      signal: (pid, signal, scope) => { signals.push([pid, signal, scope]); } }, ROOT, undefined),
    /the held process ended during capture; nothing signalled/);
    assert.deepEqual(signals, []);
  });
}

test("after a timeout a pid now held by another child is not forced (issue #473)", async (t) => {
  held.set(ROOT, {} as ChildProcess);
  t.after(() => held.delete(ROOT));
  const signals: NodeJS.Signals[] = [];
  await assert.rejects(terminate({ processRelations: timesOut,
    processStart: async () => { held.set(ROOT, {} as ChildProcess); return "replacement"; },
    signal: (_pid, signal) => { signals.push(signal); } }, ROOT, undefined),
  /ETIMEDOUT; the root is no longer the recorded process, so nothing was forced/);
  assert.deepEqual(signals, []);
});

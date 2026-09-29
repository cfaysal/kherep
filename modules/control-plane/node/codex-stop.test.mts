import assert from "node:assert/strict";
import test from "node:test";

import { processTree, terminate, type ProcessIdentity } from "./codex-stop.mts";

const ROOT = 40_001;
const CHILD = 40_002;
const TREE: ProcessIdentity[] = [{ pid: ROOT, start: "root-start" }, { pid: CHILD, start: "child-start" }];

test("termination confirms every captured pid start identity before returning", async () => {
  const starts = new Map(TREE.map((entry) => [entry.pid, entry.start]));
  const signals: NodeJS.Signals[] = [];
  await terminate({ processTree: () => TREE, processStart: (pid) => starts.get(pid) ?? null, graceMs: 1,
    signal: (_pid, signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") starts.clear();
    } }, ROOT, "root-start");
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual([...starts], []);
});

test("Windows process discovery captures the root and every descendant identity", () => {
  const starts = new Map([[ROOT, "root-start"], [CHILD, "child-start"], [40_003, "grandchild-start"], [40_004, "unrelated-start"]]);
  const relations = [{ pid: CHILD, ppid: ROOT }, { pid: 40_003, ppid: CHILD }, { pid: 40_004, ppid: 10 }];
  assert.deepEqual(processTree({ platform: "win32", processStart: (pid) => starts.get(pid) ?? null,
    processRelations: () => relations }, ROOT), TREE.concat({ pid: 40_003, start: "grandchild-start" }));
  assert.deepEqual(processTree({ platform: "win32", processStart: (pid) => starts.get(pid) ?? null,
    processRelations: () => [] }, ROOT), [TREE[0]]);
});

test("a reused root pid during grace is not signalled again", async () => {
  const starts = new Map(TREE.map((entry) => [entry.pid, entry.start]));
  const signals: NodeJS.Signals[] = [];
  await assert.rejects(terminate({ processTree: () => TREE, processStart: (pid) => starts.get(pid) ?? null, graceMs: 1,
    signal: (_pid, signal) => {
      signals.push(signal);
      starts.set(ROOT, "reused-root");
    } }, ROOT, "root-start"), /root process was reused before SIGKILL/);
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(starts.get(CHILD), "child-start");
});

test("an orphaned captured child prevents false stop confirmation", async () => {
  const starts = new Map(TREE.map((entry) => [entry.pid, entry.start]));
  const signals: NodeJS.Signals[] = [];
  await assert.rejects(terminate({ platform: "win32", processTree: () => TREE,
    processStart: (pid) => starts.get(pid) ?? null, graceMs: 1,
    signal: (_pid, signal) => {
      signals.push(signal);
      starts.delete(ROOT);
    } }, ROOT, "root-start"), /root process ended before SIGKILL/);
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(starts.get(CHILD), "child-start");
});

test("a tree that survives SIGKILL rejects instead of confirming a stop", async () => {
  await assert.rejects(terminate({ processTree: () => TREE, processStart: (pid) => TREE.find((entry) => entry.pid === pid)?.start ?? null,
    graceMs: 1, signal: () => {} }, ROOT, "root-start"), /did not stop after SIGKILL/);
});

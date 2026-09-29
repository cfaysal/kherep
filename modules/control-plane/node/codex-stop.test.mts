import assert from "node:assert/strict";
import test from "node:test";

import { terminate, type ProcessIdentity } from "./codex-stop.mts";

const ROOT = 40_001;
const CHILD = 40_002;
const TREE: ProcessIdentity[] = [{ pid: ROOT, start: "root-start" }, { pid: CHILD, start: "child-start" }];

test("termination confirms every captured pid start identity before returning", async () => {
  const starts = new Map(TREE.map((entry) => [entry.pid, entry.start]));
  const signals: NodeJS.Signals[] = [];
  await terminate({ processTree: () => TREE, processStart: (pid) => starts.get(pid) ?? null, graceMs: 1,
    signal: (_pid, signal) => {
      signals.push(signal);
      if (signal === "SIGTERM") starts.delete(ROOT);
      else starts.delete(CHILD);
    } }, ROOT, "root-start");
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual([...starts], []);
});

test("a reused pid is not signalled as part of the recorded tree", async () => {
  const starts = new Map(TREE.map((entry) => [entry.pid, entry.start]));
  const signals: NodeJS.Signals[] = [];
  await terminate({ processTree: () => TREE, processStart: (pid) => starts.get(pid) ?? null, graceMs: 1,
    signal: (_pid, signal) => {
      signals.push(signal);
      starts.set(ROOT, "reused-root");
      starts.set(CHILD, "reused-child");
    } }, ROOT, "root-start");
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(starts.get(CHILD), "reused-child");
});

test("a tree that survives SIGKILL rejects instead of confirming a stop", async () => {
  await assert.rejects(terminate({ processTree: () => TREE, processStart: (pid) => TREE.find((entry) => entry.pid === pid)?.start ?? null,
    graceMs: 1, signal: () => {} }, ROOT, "root-start"), /did not stop after SIGKILL/);
});
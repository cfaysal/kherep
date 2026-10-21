#!/usr/bin/env node
// Unit test for obs-handback-state.mts (issue #555): the per-agent state the
// PostToolUse recorder writes and the SubagentStop hook reads. Every case
// writes under its own temporary home.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clearDelivered, homeOf, prune, readDelivered, recordDelivered, stateDir, validId, writeStopTrace,
} from "./obs-handback-state.mts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "obs-handback-state-test-")));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
function home(): string {
  const dir = path.join(TMP, `home-${++seq}`);
  fs.mkdirSync(dir);
  return dir;
}

const file = (h: string, name: string) => path.join(stateDir(h), name);

test("validId accepts only a bounded opaque id", () => {
  assert.equal(validId("agent-1_A"), "agent-1_A");
  assert.equal(validId("a".repeat(64)), "a".repeat(64));
  for (const bad of ["", "../x", "a/b", "a\\b", "a.b", "a b", "a".repeat(65), 42, null, undefined, {}]) {
    assert.equal(validId(bad), null, String(bad));
  }
});

test("homeOf is the parent of the invoked hooks directory", () => {
  assert.equal(homeOf(path.join(TMP, "root", "hooks", "obs-result-check.mts")), path.join(TMP, "root"));
  assert.equal(stateDir(path.join(TMP, "root")), path.join(TMP, "root", ".cache", "obs-result-check"));
});

test("recordDelivered stores the verdict and the tool_use_id, last write wins", () => {
  const h = home();
  recordDelivered(h, "a1", "wrote", "toolu_01ABC");
  assert.equal(fs.readFileSync(file(h, "a1.delivered"), "utf8"), "wrote\ttoolu_01ABC\n");
  assert.deepEqual(readDelivered(h, "a1"), { verdict: "wrote", toolUseId: "toolu_01ABC" });
  recordDelivered(h, "a1", "malformed more than one OBS-RESULT line", 42);
  assert.deepEqual(readDelivered(h, "a1"), { verdict: "malformed more than one OBS-RESULT line", toolUseId: "-" });
  recordDelivered(h, "a1", "empty", "not an id");
  assert.deepEqual(readDelivered(h, "a1"), { verdict: "empty", toolUseId: "-" });
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file(h, "a1.delivered")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(stateDir(h)).mode & 0o777, 0o700);
  }
});

test("readDelivered tells an absent state from an unreadable one", () => {
  const h = home();
  assert.equal(readDelivered(h, "none"), null);
  fs.mkdirSync(file(h, "dir.delivered"), { recursive: true });
  assert.equal(readDelivered(h, "dir"), "unreadable");
  fs.writeFileSync(file(h, "notab.delivered"), "wrote\n");
  assert.equal(readDelivered(h, "notab"), "unreadable");
});

test("clearDelivered removes the state, and a missing one is no error", () => {
  const h = home();
  recordDelivered(h, "a1", "wrote", "t1");
  clearDelivered(h, "a1");
  assert.equal(readDelivered(h, "a1"), null);
  clearDelivered(h, "a1");
});

test("reads, clears and prunes create no state directory", () => {
  const h = home();
  readDelivered(h, "a1");
  clearDelivered(h, "a1");
  prune(h);
  assert.equal(fs.existsSync(path.join(h, ".cache")), false);
});

test("prune removes files older than 24 h and keeps young ones", () => {
  const h = home();
  recordDelivered(h, "old", "wrote", "t1");
  recordDelivered(h, "young", "wrote", "t2");
  writeStopTrace(h, "old", { mode: "auto", state: "absent", waited: 0, after: "-", transcript: "none", branch: "auto" });
  const then = new Date(Date.now() - 25 * 3_600_000);
  fs.utimesSync(file(h, "old.delivered"), then, then);
  fs.utimesSync(file(h, "old.stop"), then, then);
  prune(h);
  assert.equal(fs.existsSync(file(h, "old.delivered")), false);
  assert.equal(fs.existsSync(file(h, "old.stop")), false);
  assert.equal(fs.existsSync(file(h, "young.delivered")), true);
});

test("prune does not follow a state directory that is a link", () => {
  const h = home();
  const target = path.join(TMP, `link-target-${seq}`);
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "old.delivered"), "wrote\tt1\n");
  const then = new Date(Date.now() - 25 * 3_600_000);
  fs.utimesSync(path.join(target, "old.delivered"), then, then);
  fs.mkdirSync(path.join(h, ".cache"));
  fs.symlinkSync(target, stateDir(h), process.platform === "win32" ? "junction" : "dir");
  prune(h);
  assert.equal(fs.existsSync(path.join(target, "old.delivered")), true);
});

test("writeStopTrace writes the fixed keys and never a payload value", () => {
  const h = home();
  writeStopTrace(h, "a1", { mode: "auto", state: "absent", waited: 300, after: "present", transcript: "none", branch: "state" });
  assert.equal(fs.readFileSync(file(h, "a1.stop"), "utf8"),
    "mode=auto state=absent waited=300 after=present transcript=none branch=state\n");
  writeStopTrace(h, "a1", { mode: "Example Corp host.example.com", state: "present", waited: 0, after: "-", transcript: "delivered", branch: "state" });
  assert.match(fs.readFileSync(file(h, "a1.stop"), "utf8"), /^mode=other state=present /);
  writeStopTrace(h, "a1", { mode: undefined, state: "present", waited: 0, after: "-", transcript: "delivered", branch: "state" });
  assert.match(fs.readFileSync(file(h, "a1.stop"), "utf8"), /^mode=- /);
});

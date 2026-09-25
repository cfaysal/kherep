import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getMessage, markOffered, MAX_REPLY_DEPTH, writeJsonAtomic } from "./inbox.mts";
import {
  killSwitch, listenerDir, REARM_TEXT, runWake, WAKE_GRACE_MS, WAKE_MAX_WAIT_MS, WAKE_POLL_MS, WAKE_SETTLE_MS, WAKE_TIMEOUT_S,
  wakeAudit, wakeText,
} from "./wake-hook.mts";
import { arrive, auditLines, listen, lockFile, SECRET, SELF, setup, T0 } from "./wake-fixture.mts";

// The wake listener (issue #31): a fake clock and sleep drive it, so no test
// waits in real time except the one that runs the script as Claude Code would.
// wake-guards.test.mts covers the policy, budget and permission guards.

const HOOK = fileURLToPath(new URL("./wake-hook.mts", import.meta.url));
const TYPE_STRIPPING_WARNING = new RegExp("^\\(node:\\d+\\) ExperimentalWarning: Type Stripping is an experimental "
  + "feature and might change at any time\\r?\\n\\(Use `node --trace-warnings \\.\\.\\.` to show where the warning was "
  + "created\\)\\r?\\n", "gm");
const withoutTypeStrippingWarning = (stderr: string | Buffer): string => String(stderr).replace(TYPE_STRIPPING_WARNING, "");

test("wakes with the fixed text for a message that arrives after the grace period, by name or id", async (t) => {
  const { paths } = setup(t);
  let byName = "";
  let byId = "";
  const result = await listen(paths, { tick: (clock) => {
    if (clock === T0 + 2 * WAKE_POLL_MS) {
      byName = arrive(paths, 1, clock);
      byId = arrive(paths, 2, clock, SELF);
    }
  } });
  assert.deepEqual(result, { code: 2, text: wakeText(2) });
  assert.equal(wakeText(2), "Kherep: 2 new message(s) from other agent sessions arrived. They are delivered in this turn.");
  assert.deepEqual(auditLines(paths),
    [{ ts: new Date(T0 + 2 * WAKE_POLL_MS + WAKE_SETTLE_MS).toISOString(), sessionId: SELF, messageIds: [byName, byId], action: "wake" }]);
  assert.ok(!fs.readFileSync(wakeAudit(paths), "utf8").includes(SECRET), "the audit never carries message text");
  assert.equal(getMessage(paths.inbox, byName)?.state, "accepted", "the delivery hook of the woken turn offers it");
  assert.equal(fs.existsSync(lockFile(paths)), false);
});

test("ignores what arrived up to the grace period after arming, then re-arms itself before the timeout", async (t) => {
  const { paths } = setup(t);
  const before = arrive(paths, 1, T0 - 1_000);
  let during = "";
  const result = await listen(paths, { maxWaitMs: 10_000, tick: (clock) => {
    if (clock === T0 + WAKE_POLL_MS) during = arrive(paths, 2, T0 + WAKE_GRACE_MS);
  } });
  // Claude Code kills a listener at its timeout without waking the session, so
  // the listener wakes it first; that turn starts the next listener.
  assert.deepEqual(result, { code: 2, text: REARM_TEXT });
  assert.equal(REARM_TEXT, "Kherep: message listener re-armed.");
  assert.equal(WAKE_MAX_WAIT_MS, (WAKE_TIMEOUT_S - 60) * 1000);
  assert.deepEqual([getMessage(paths.inbox, before)?.state, getMessage(paths.inbox, during)?.state], ["accepted", "accepted"]);
  assert.deepEqual(auditLines(paths).map((l) => [l.action, l.messageIds]), [["rearm", []]]);
  assert.equal(fs.existsSync(lockFile(paths)), false, "the re-arming listener releases its lock");
});

test("re-reads the state before waking: a message a delivery hook offered meanwhile wakes nobody", async (t) => {
  const { paths } = setup(t);
  let messageId = "";
  const result = await listen(paths, { maxWaitMs: 10_000, tick: (clock) => {
    if (clock === T0 + 2 * WAKE_POLL_MS) messageId = arrive(paths, 1, clock);
    if (clock === T0 + 2 * WAKE_POLL_MS + WAKE_SETTLE_MS) markOffered(paths.inbox, messageId, clock);
  } });
  assert.equal(getMessage(paths.inbox, messageId)?.state, "offered");
  assert.deepEqual(result, { code: 2, text: REARM_TEXT });
  assert.deepEqual(auditLines(paths).map((l) => l.action), ["rearm"]);
});

test("a listener replaced by a newer one exits quietly and leaves the new lock; identity is the token", async (t) => {
  const { paths } = setup(t);
  // Same pid and start time, other token: still another listener.
  const newer = { token: "newer", pid: 4242, startedAt: T0, event: "Stop" };
  const result = await listen(paths, { token: "older", tick: () => writeJsonAtomic(lockFile(paths), newer) });
  assert.deepEqual(result, { code: 0 });
  assert.deepEqual(auditLines(paths).map((l) => [l.action, l.messageIds]), [["superseded", []]]);
  assert.deepEqual(JSON.parse(fs.readFileSync(lockFile(paths), "utf8")), newer);
  // A lost lock ends the listener without a line.
  const lost = setup(t).paths;
  assert.deepEqual(await listen(lost, { tick: () => fs.rmSync(lockFile(lost)) }), { code: 0 });
  assert.deepEqual(auditLines(lost), []);
});

test("the kill switch and an unenrolled machine keep the listener from starting", async (t) => {
  const { paths } = setup(t);
  fs.writeFileSync(killSwitch(paths), "");
  arrive(paths, 1, T0 + 10_000);
  assert.deepEqual(await listen(paths, { tick: () => assert.fail("no poll with the kill switch set") }), { code: 0 });
  assert.deepEqual(auditLines(paths).map((l) => l.action), ["disabled"]);
  assert.equal(fs.existsSync(listenerDir(paths)), false);

  const none = setup(t, { enrolled: false }).paths;
  assert.deepEqual(await listen(none, { tick: () => assert.fail("no poll without a node") }), { code: 0 });
  assert.equal(fs.existsSync(none.dir), false, "an unenrolled machine gets no files");
  for (const bad of [undefined, "", "../x", "a/b"]) {
    assert.deepEqual(await runWake({ session_id: bad, hook_event_name: "Stop" }, { paths, sleep: async () => assert.fail("no poll") }),
      { code: 0 });
  }
  assert.deepEqual(await runWake({ session_id: SELF, hook_event_name: "PreToolUse" }, { paths, sleep: async () => assert.fail("no poll") }),
    { code: 0 });
});

test("a message at the reply limit does not wake the session; the audit says so once", async (t) => {
  const { paths } = setup(t);
  const deep = arrive(paths, 1, T0 + 5_000, "review", MAX_REPLY_DEPTH);
  assert.deepEqual(await listen(paths, { maxWaitMs: 20_000 }), { code: 2, text: REARM_TEXT });
  assert.deepEqual(auditLines(paths).map((l) => [l.action, l.messageIds]), [["depth-limit", [deep]], ["rearm", []]]);
  assert.equal(getMessage(paths.inbox, deep)?.state, "accepted");

  const mixed = setup(t).paths;
  arrive(mixed, 1, T0 + 5_000, "review", MAX_REPLY_DEPTH);
  const shallow = arrive(mixed, 2, T0 + 5_000, "review", MAX_REPLY_DEPTH - 1);
  assert.deepEqual(await listen(mixed), { code: 2, text: wakeText(1) });
  assert.deepEqual(auditLines(mixed).map((l) => l.action), ["depth-limit", "wake"]);
  assert.deepEqual(auditLines(mixed)[1].messageIds, [shallow]);
});

test("runs as Claude Code starts it: exit 2 with the wake text on stderr, exit 0 without a node or with a bad --timeout", (t) => {
  const { root, paths } = setup(t);
  // Arrived well after the grace period, so the first poll wakes.
  arrive(paths, 1, Date.now() + 60_000, SELF);
  const input = JSON.stringify({ session_id: SELF, hook_event_name: "Stop", stop_hook_active: false, permission_mode: "default" });
  const run = (args: string[], dir: string, stdin = input) => spawnSync(process.execPath, [HOOK, ...args],
    { input: stdin, env: { ...process.env, KHEREP_CONFIG_DIR: dir }, encoding: "utf8", timeout: 30_000 });
  // A --timeout too short for the re-arm margin ends it before it listens.
  const short = run(["--timeout", "90"], root);
  assert.deepEqual([short.status, short.stdout, withoutTypeStrippingWarning(short.stderr)], [0, "", ""]);
  const woken = run(["--timeout", String(WAKE_TIMEOUT_S)], root);
  assert.deepEqual([woken.status, woken.stdout, withoutTypeStrippingWarning(woken.stderr)], [2, "", `${wakeText(1)}\n`]);

  const empty = setup(t, { enrolled: false }).root;
  for (const stdin of [input, "{not json", ""]) {
    const quiet = run([], empty, stdin);
    assert.deepEqual([quiet.status, quiet.stdout, withoutTypeStrippingWarning(quiet.stderr)], [0, "", ""], stdin);
  }
});

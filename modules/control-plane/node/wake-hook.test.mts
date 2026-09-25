import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ensureDir, nodePaths, type NodePaths } from "./config.mts";
import { writeLocalSessions } from "./exchange.mts";
import { getMessage, markOffered, MAX_REPLY_DEPTH, storeMessage, writeJsonAtomic } from "./inbox.mts";
import {
  killSwitch, listenerDir, REARM_TEXT, runWake, WAKE_GRACE_MS, WAKE_MAX_WAIT_MS, WAKE_POLL_MS, WAKE_SETTLE_MS, WAKE_TIMEOUT_S,
  wakeAudit, WAKES_PER_HOUR, wakeText,
} from "./wake-hook.mts";

// The wake listener (issue #31): a fake clock and sleep drive it, so no test
// waits in real time except the one that runs the script as Claude Code would.

const PEER = "00000000-0000-4000-8000-0000000000cc";
const SELF = "s-self";
const SECRET = "peer text that must never reach the audit";
const T0 = Date.UTC(2026, 8, 25, 12);
const HOOK = fileURLToPath(new URL("./wake-hook.mts", import.meta.url));
const TYPE_STRIPPING_WARNING = new RegExp("^\\(node:\\d+\\) ExperimentalWarning: Type Stripping is an experimental "
  + "feature and might change at any time\\r?\\n\\(Use `node --trace-warnings \\.\\.\\.` to show where the warning was "
  + "created\\)\\r?\\n", "gm");
const withoutTypeStrippingWarning = (stderr: string | Buffer): string => String(stderr).replace(TYPE_STRIPPING_WARNING, "");

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

function setup(t: test.TestContext, enrolled = true): { root: string; paths: NodePaths } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-wake-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  if (enrolled) {
    ensureDir(paths.dir);
    fs.writeFileSync(paths.config, "{}\n");
    writeLocalSessions(paths, [{ sessionId: SELF, runtime: "claude-code", state: "idle", name: "review" }]);
  }
  return { root, paths };
}

function arrive(paths: NodePaths, n: number, at: number, toSession = "review", depth = 0): string {
  storeMessage(paths.inbox, { messageId: id(n), from: { nodeId: PEER, session: "build" }, toSession, text: `${SECRET} ${n}`,
    createdAt: new Date(at).toISOString() }, at, depth);
  return id(n);
}

// A listener on a fake clock; tick(clock) runs after each sleep, before the poll.
// The Stop input carries stop_hook_active true in a turn a Stop hook continued,
// the woken turn included; the listener arms all the same.
function listen(paths: NodePaths, options: { start?: number; tick?: (clock: number) => void; maxWaitMs?: number; pid?: number } = {}) {
  let clock = options.start ?? T0;
  return runWake({ session_id: SELF, hook_event_name: "Stop", stop_hook_active: true }, {
    paths, pid: options.pid ?? 4242, maxWaitMs: options.maxWaitMs ?? 60_000, now: () => clock,
    sleep: async (ms) => { clock += ms; options.tick?.(clock); },
  });
}

const auditLines = (paths: NodePaths) =>
  fs.existsSync(wakeAudit(paths)) ? fs.readFileSync(wakeAudit(paths), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
const lockFile = (paths: NodePaths) => path.join(listenerDir(paths), `${SELF}.json`);

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
  assert.equal(getMessage(paths.inbox, byName)?.state, "accepted", "the Stop delivery hook of the woken turn offers it");
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
  // the listener wakes it first; that turn's Stop starts the next listener.
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

test("a listener replaced by a newer Stop's listener exits quietly and leaves the new lock", async (t) => {
  const { paths } = setup(t);
  const newer = { pid: 5151, startedAt: T0 + 1 };
  const result = await listen(paths, { tick: () => writeJsonAtomic(lockFile(paths), newer) });
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

  const none = setup(t, false).paths;
  assert.deepEqual(await listen(none, { tick: () => assert.fail("no poll without a node") }), { code: 0 });
  assert.equal(fs.existsSync(none.dir), false, "an unenrolled machine gets no files");
  for (const bad of [undefined, "", "../x", "a/b"]) {
    assert.deepEqual(await runWake({ session_id: bad }, { paths, sleep: async () => assert.fail("no poll") }), { code: 0 });
  }
});

test(`wakes a session at most ${WAKES_PER_HOUR} times per rolling hour`, async (t) => {
  const { paths } = setup(t);
  const wakeAt = async (n: number, start: number) =>
    listen(paths, { start, tick: (clock) => { if (clock === start + 2 * WAKE_POLL_MS) arrive(paths, n, clock); } });
  for (let n = 1; n <= WAKES_PER_HOUR; n++) assert.equal((await wakeAt(n, T0 + n * 60_000)).code, 2, `wake ${n}`);
  assert.deepEqual(await wakeAt(20, T0 + 7 * 60_000), { code: 0 });
  assert.equal(getMessage(paths.inbox, id(20))?.state, "accepted", "a rate-limited message waits for the next turn");
  assert.deepEqual(auditLines(paths).at(-1)?.action, "rate-limited");
  // One token comes back every hour / WAKES_PER_HOUR.
  assert.equal((await wakeAt(21, T0 + 7 * 60_000 + 60 * 60_000 / WAKES_PER_HOUR)).code, 2);
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

test("runs as Claude Code starts it: exit 2 with the wake text on stderr, exit 0 without a node", (t) => {
  const { root, paths } = setup(t);
  // Arrived well after the grace period, so the first poll wakes.
  arrive(paths, 1, Date.now() + 60_000, SELF);
  const input = JSON.stringify({ session_id: SELF, hook_event_name: "Stop", stop_hook_active: false });
  const woken = spawnSync(process.execPath, [HOOK], { input, env: { ...process.env, KHEREP_CONFIG_DIR: root }, encoding: "utf8", timeout: 30_000 });
  assert.deepEqual([woken.status, woken.stdout, withoutTypeStrippingWarning(woken.stderr)], [2, "", `${wakeText(1)}\n`]);

  const empty = setup(t, false).root;
  for (const stdin of [input, "{not json", ""]) {
    const quiet = spawnSync(process.execPath, [HOOK], { input: stdin, env: { ...process.env, KHEREP_CONFIG_DIR: empty }, encoding: "utf8", timeout: 30_000 });
    assert.deepEqual([quiet.status, quiet.stdout, withoutTypeStrippingWarning(quiet.stderr)], [0, "", ""], stdin);
  }
});

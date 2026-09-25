import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { markListenerIdle, TURN_SPACING_MS, TURNS_PER_HOUR } from "./autonomy.mts";
import { REOFFER_AFTER_MS } from "./deliver-core.mts";
import { getMessage, markOffered } from "./inbox.mts";
import { listenerDir, REARM_TEXT, STUCK_TEXT, WAKE_GRACE_MS, WAKE_POLL_MS, wakeMaxWaitMs, WAKE_MAX_WAIT_MS, wakeText } from "./wake-hook.mts";
import { arrive, auditLines, id, listen, lockFile, SECRET, SELF, setup, T0, type ListenOptions } from "./wake-fixture.mts";

// Guards of the wake listener (issue #31, operator decisions of 2026-09-25):
// opt-in policy, per-session allowlist, budget, permission mode, arming at
// UserPromptSubmit, stuck offers, parent death and the --timeout argument.

const LATER = T0 + 2 * WAKE_POLL_MS;
// Listens until a message arriving at the second poll wakes it, or 60 s pass.
const listenFor = (paths: Parameters<typeof listen>[0], n: number, options: ListenOptions = {}) => {
  const start = options.start ?? T0;
  return listen(paths, { ...options, tick: (clock) => {
    if (clock === start + 2 * WAKE_POLL_MS) arrive(paths, n, clock);
    options.tick?.(clock);
  } });
};

test("no wake without an opt-in: missing, disabled or malformed wake sections arm nothing", async (t) => {
  const malformed = [undefined, false, { enabled: false, sessions: ["*"] }, { enabled: "true", sessions: ["*"] }, { enabled: true },
    { enabled: true, sessions: [] }, { enabled: true, sessions: "*" }, { enabled: true, sessions: ["review", 7] }];
  for (const wake of malformed) {
    const { paths } = setup(t, { wake });
    arrive(paths, 1, T0 + 10_000);
    assert.deepEqual(await listen(paths, { tick: () => assert.fail(`no poll for ${JSON.stringify(wake)}`) }), { code: 0 });
    assert.equal(fs.existsSync(listenerDir(paths)), false);
    assert.deepEqual(auditLines(paths), []);
  }
  // A policy file that does not parse fails closed as a whole.
  const broken = setup(t).paths;
  fs.writeFileSync(broken.policy, "{not json");
  assert.deepEqual(await listen(broken, { tick: () => assert.fail("no poll") }), { code: 0 });
});

test("only allowlisted sessions are woken: by id, by name or by an explicit \"*\"", async (t) => {
  const other = setup(t, { wake: { enabled: true, sessions: ["someone-else"] } }).paths;
  assert.deepEqual(await listen(other, { tick: () => assert.fail("no poll") }), { code: 0 });
  assert.deepEqual(auditLines(other).map((l) => [l.action, l.sessionId]), [["not-allowlisted", SELF]]);
  for (const sessions of [[SELF], ["review"], ["*"]]) {
    const { paths } = setup(t, { wake: { enabled: true, sessions } });
    assert.deepEqual(await listenFor(paths, 1), { code: 2, text: wakeText(1) }, JSON.stringify(sessions));
  }
});

test("a session in bypassPermissions is never woken; the other permission modes are", async (t) => {
  const bypass = setup(t).paths;
  assert.deepEqual(await listen(bypass, { mode: "bypassPermissions", tick: () => assert.fail("no poll") }), { code: 0 });
  assert.deepEqual(auditLines(bypass).map((l) => l.action), ["permission-mode"]);
  assert.equal(fs.existsSync(lockFile(bypass)), false);
  for (const mode of ["default", "acceptEdits", "plan", "auto", "dontAsk"]) {
    const { paths } = setup(t);
    assert.deepEqual(await listenFor(paths, 1, { mode }), { code: 2, text: wakeText(1) }, mode);
  }
});

test(`wakes at most ${TURNS_PER_HOUR} times per rolling hour and waits out the spacing`, async (t) => {
  const { paths } = setup(t);
  for (let n = 1; n <= TURNS_PER_HOUR; n++) assert.equal((await listenFor(paths, n, { start: T0 + n * 60_000 })).code, 2, `wake ${n}`);
  assert.deepEqual(await listenFor(paths, 20, { start: T0 + 7 * 60_000 }), { code: 0 });
  assert.equal(getMessage(paths.inbox, id(20))?.state, "accepted", "it waits for the next user prompt");
  assert.deepEqual(auditLines(paths).at(-1), { ts: new Date(T0 + 7 * 60_000 + 2 * WAKE_POLL_MS + 250).toISOString(),
    sessionId: SELF, messageIds: [id(20)], action: "budget" });
  // The first wake leaves the rolling hour one hour after it was taken.
  const firstWake = Date.parse(auditLines(paths)[0].ts);
  assert.equal((await listenFor(paths, 21, { start: firstWake + 60 * 60_000 })).code, 2);

  // Spacing: a message 10 s after a wake wakes once 30 s have passed.
  const spaced = setup(t).paths;
  assert.equal((await listenFor(spaced, 1)).code, 2);
  const start = T0 + 10_000;
  assert.deepEqual(await listenFor(spaced, 2, { start }), { code: 2, text: wakeText(1) });
  const [first, second] = auditLines(spaced).map((l) => Date.parse(l.ts));
  assert.ok(second - first >= TURN_SPACING_MS && second - first < TURN_SPACING_MS + 2 * WAKE_POLL_MS + 250, `${second - first}`);
});

test("armed at UserPromptSubmit it stays silent while the turn may run, and wakes once StopFailure ended it", async (t) => {
  const { paths } = setup(t);
  let messageId = "";
  const result = await listen(paths, { event: "UserPromptSubmit", maxWaitMs: 60 * 60_000, tick: (clock) => {
    if (clock === LATER) messageId = arrive(paths, 1, clock);
    // The turn's Stop would offer it; StopFailure instead marks the listener idle.
    if (clock === T0 + 60_000) markListenerIdle(paths, SELF, clock);
  } });
  assert.deepEqual(result, { code: 2, text: wakeText(1) });
  assert.equal(Date.parse(auditLines(paths)[0].ts), T0 + 60_000 + 250);
  assert.deepEqual(auditLines(paths)[0].messageIds, [messageId]);

  // After a user interrupt nothing marks it: idle once the turn cannot still run.
  const interrupted = setup(t).paths;
  assert.deepEqual(await listenFor(interrupted, 1, { event: "UserPromptSubmit", maxWaitMs: 60 * 60_000 }), { code: 2, text: wakeText(1) });
  assert.equal(Date.parse(auditLines(interrupted)[0].ts), T0 + REOFFER_AFTER_MS + 250);
});

test("UserPromptSubmit and Stop arming never leave two listeners for one session", async (t) => {
  const { paths } = setup(t);
  const early = listen(paths, { event: "UserPromptSubmit", token: "ups" });
  // The turn ends with Stop: its listener takes the lock over.
  const late = listenFor(paths, 1, { token: "stop" });
  assert.deepEqual(await early, { code: 0 });
  assert.deepEqual(await late, { code: 2, text: wakeText(1) });
  assert.deepEqual(auditLines(paths).map((l) => l.action), ["superseded", "wake"]);
  // StopFailure marks only a listener armed at UserPromptSubmit.
  const stopLock = { token: "t", pid: 1, startedAt: T0, event: "Stop" };
  fs.mkdirSync(listenerDir(paths), { recursive: true });
  fs.writeFileSync(lockFile(paths), JSON.stringify(stopLock));
  markListenerIdle(paths, SELF, T0);
  assert.deepEqual(JSON.parse(fs.readFileSync(lockFile(paths), "utf8")), stopLock);
});

test("an offer left by a turn that ended without Stop wakes the idle session once", async (t) => {
  const { paths } = setup(t);
  const stuck = arrive(paths, 1, T0 - REOFFER_AFTER_MS - 5_000);
  markOffered(paths.inbox, stuck, T0 - REOFFER_AFTER_MS);
  assert.deepEqual(await listen(paths), { code: 2, text: STUCK_TEXT });
  assert.deepEqual(auditLines(paths).map((l) => [l.action, l.messageIds]), [["stuck-offer", [stuck]]]);
  assert.equal(Date.parse(auditLines(paths)[0].ts) >= T0 + WAKE_GRACE_MS, true, "not before the parallel Stop could confirm it");
  // Never twice for one record: the next listener re-arms instead.
  assert.deepEqual(await listen(paths, { start: T0 + 60_000, maxWaitMs: 30_000 }), { code: 2, text: REARM_TEXT });
  assert.equal(getMessage(paths.inbox, stuck)?.state, "offered", "the next prompt offers it again");
  assert.ok(!fs.readFileSync(`${paths.dir}/wake.jsonl`, "utf8").includes(SECRET));
});

test("the listener exits when the process that started it is gone", async (t) => {
  const { paths } = setup(t);
  let polls = 0;
  assert.deepEqual(await listen(paths, { parentAlive: () => ++polls < 2 }), { code: 0 });
  assert.deepEqual(auditLines(paths).map((l) => l.action), ["parent-gone"]);
  assert.equal(fs.existsSync(lockFile(paths)), false);
});

test("--timeout drives the re-arm deadline: 60 s before the timeout", async (t) => {
  assert.equal(wakeMaxWaitMs([]), WAKE_MAX_WAIT_MS);
  assert.equal(wakeMaxWaitMs(["--timeout", "3600"]), 3_540_000);
  for (const bad of [["--timeout"], ["--timeout", "x"], ["--timeout", "120"], ["--timeout", "1.5"]]) assert.equal(wakeMaxWaitMs(bad), null);
  const { paths } = setup(t);
  assert.deepEqual(await listen(paths, { maxWaitMs: wakeMaxWaitMs(["--timeout", "3600"]) as number }), { code: 2, text: REARM_TEXT });
  assert.equal(Date.parse(auditLines(paths)[0].ts), T0 + 3_540_000);
});

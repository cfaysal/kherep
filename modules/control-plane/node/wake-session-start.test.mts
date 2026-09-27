import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { markListenerIdle, TURNS_PER_HOUR } from "./autonomy.mts";
import { MAX_REPLY_DEPTH } from "./inbox.mts";
import { killSwitch, REARM_TEXT, WAKE_POLL_MS, WAKE_SETTLE_MS, wakeText } from "./wake-hook.mts";
import { arrive, auditLines, listen, lockFile, SELF, setup, T0, type ListenOptions } from "./wake-fixture.mts";

// Issue #97: the listener armed at SessionStart, so an idle session stays
// wakeable after its process restarts. A SessionStart input carries source but
// no permission_mode (measured on Claude Code 2.1.258), so these listeners
// leave the field out unless a test says otherwise.

const LATER = T0 + 2 * WAKE_POLL_MS;
const atStart = (source: string, options: ListenOptions = {}): ListenOptions =>
  ({ event: "SessionStart", source, mode: null, ...options });
// Listens until a message arriving at the second poll wakes it, or 60 s pass.
const listenFor = (paths: Parameters<typeof listen>[0], n: number, options: ListenOptions = {}) => {
  const start = options.start ?? T0;
  return listen(paths, { ...options, tick: (clock) => {
    if (clock === start + 2 * WAKE_POLL_MS) arrive(paths, n, clock);
    options.tick?.(clock);
  } });
};

test("armed at SessionStart, an idle session wakes on a message after startup, resume, clear and fork", async (t) => {
  for (const source of ["startup", "resume", "clear", "fork"]) {
    const { paths } = setup(t);
    let armed: unknown;
    const result = await listenFor(paths, 1, atStart(source, { tick: (clock) => {
      if (clock === T0 + WAKE_POLL_MS) armed = JSON.parse(fs.readFileSync(lockFile(paths), "utf8"));
    } }));
    assert.deepEqual(result, { code: 2, text: wakeText(1) }, source);
    assert.deepEqual(armed, { token: (armed as { token: string }).token, pid: 4242, startedAt: T0, event: "SessionStart", source });
    assert.deepEqual(auditLines(paths).map((l) => [l.action, Date.parse(l.ts)]), [["wake", LATER + WAKE_SETTLE_MS]], source);
    assert.equal(fs.existsSync(lockFile(paths)), false, source);
  }
});

test("after compaction, which can run inside a turn, it stays silent until the turn has ended", async (t) => {
  const { paths } = setup(t);
  const result = await listenFor(paths, 1, atStart("compact", { maxWaitMs: 60 * 60_000, tick: (clock) => {
    if (clock === T0 + 60_000) markListenerIdle(paths, SELF, clock);
  } }));
  assert.deepEqual(result, { code: 2, text: wakeText(1) });
  assert.equal(Date.parse(auditLines(paths)[0].ts), T0 + 60_000 + WAKE_SETTLE_MS);
  // StopFailure marks no listener armed while the session was idle.
  const lock = { token: "t", pid: 1, startedAt: T0, event: "SessionStart", source: "resume" };
  fs.writeFileSync(lockFile(paths), JSON.stringify(lock));
  markListenerIdle(paths, SELF, T0);
  assert.deepEqual(JSON.parse(fs.readFileSync(lockFile(paths), "utf8")), lock);
});

test("a UserPromptSubmit after SessionStart supersedes its listener; one listener remains", async (t) => {
  const { paths } = setup(t);
  const early = listen(paths, atStart("resume", { token: "start" }));
  let held: unknown;
  const late = listen(paths, { event: "UserPromptSubmit", token: "prompt", maxWaitMs: 10_000, tick: (clock) => {
    if (clock === T0 + WAKE_POLL_MS) held = JSON.parse(fs.readFileSync(lockFile(paths), "utf8")).token;
  } });
  assert.deepEqual(await early, { code: 0 });
  assert.deepEqual(await late, { code: 2, text: REARM_TEXT });
  assert.equal(held, "prompt");
  assert.deepEqual(auditLines(paths).map((l) => l.action), ["superseded", "rearm"]);
  assert.equal(fs.existsSync(lockFile(paths)), false, "the re-arming listener released the only lock");
});

test("the permission mode: the input's if given, else the one the session's last prompt or Stop reported", async (t) => {
  // Listed only through "*": without a known mode SessionStart arms nothing.
  const any = setup(t, { wake: { enabled: true, sessions: ["*"] } }).paths;
  assert.deepEqual(await listen(any, atStart("resume", { tick: () => assert.fail("no poll") })), { code: 0 });
  assert.deepEqual(auditLines(any).map((l) => l.action), ["permission-mode-unknown"]);
  assert.equal(fs.existsSync(lockFile(any)), false);
  // A Stop listener in mode default reports it; the next SessionStart uses it.
  assert.equal((await listenFor(any, 1)).code, 2);
  assert.deepEqual(await listenFor(any, 2, atStart("resume", { start: T0 + 60_000 })), { code: 2, text: wakeText(1) });
  // Stopped last in bypassPermissions: refused, as is an input that says so.
  assert.deepEqual(await listen(any, { mode: "bypassPermissions", tick: () => assert.fail("no poll") }), { code: 0 });
  assert.deepEqual(await listen(any, atStart("resume", { tick: () => assert.fail("no poll") })), { code: 0 });
  const listed = setup(t).paths;
  assert.deepEqual(await listen(listed, atStart("startup", { mode: "bypassPermissions", tick: () => assert.fail("no poll") })),
    { code: 0 });
  assert.deepEqual([...auditLines(any).slice(-2), ...auditLines(listed)].map((l) => l.action),
    ["permission-mode", "permission-mode", "permission-mode"]);
});

test("the other guards hold at SessionStart: kill switch, opt-in, allowlist, reply depth and budget", async (t) => {
  const off = setup(t).paths;
  fs.writeFileSync(killSwitch(off), "");
  assert.deepEqual(await listen(off, atStart("resume", { tick: () => assert.fail("no poll") })), { code: 0 });
  assert.deepEqual(auditLines(off).map((l) => l.action), ["disabled"]);

  const none = setup(t, { wake: undefined }).paths;
  assert.deepEqual(await listen(none, atStart("resume", { tick: () => assert.fail("no poll") })), { code: 0 });
  assert.deepEqual(auditLines(none), []);

  const other = setup(t, { wake: { enabled: true, sessions: ["someone-else"] } }).paths;
  assert.deepEqual(await listen(other, atStart("resume", { tick: () => assert.fail("no poll") })), { code: 0 });
  assert.deepEqual(auditLines(other).map((l) => l.action), ["not-allowlisted"]);

  const deep = setup(t).paths;
  arrive(deep, 1, T0 + 5_000, "review", MAX_REPLY_DEPTH);
  assert.deepEqual(await listen(deep, atStart("resume", { maxWaitMs: 20_000 })), { code: 2, text: REARM_TEXT });
  assert.deepEqual(auditLines(deep).map((l) => l.action), ["depth-limit", "rearm"]);

  const { paths } = setup(t);
  for (let n = 1; n <= TURNS_PER_HOUR; n++) {
    assert.equal((await listenFor(paths, n, atStart("resume", { start: T0 + n * 60_000 }))).code, 2, `wake ${n}`);
  }
  assert.deepEqual(await listenFor(paths, 20, atStart("resume", { start: T0 + 7 * 60_000 })), { code: 0 });
  assert.equal(auditLines(paths).at(-1)?.action, "budget");
});

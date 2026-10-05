import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { takeTurn, TURN_SPACING_MS, TURNS_PER_DAY, TURNS_PER_HOUR } from "./autonomy.mts";
import type { NodePaths } from "./config.mts";
import { deliverForHook } from "./deliver-hook.mts";
import { checkPolicy } from "./doctor-local.mts";
import { DEFAULT_POLICY, DEFAULT_TURN_BUDGET, readPolicy, wakeBudget } from "./policy.mts";
import { arrive, auditLines, id, listen, SELF, setup, T0 } from "./wake-fixture.mts";
import { WAKE_POLL_MS } from "./wake-hook.mts";

// The configurable per-session turn budget (issue #259): wake.budget in the
// node policy, with hard bounds, fail closed, and one effective budget for the
// listener, the Stop continuations and the daemon's wake paths.

const HOUR = 60 * 60_000;
const WAKE = { enabled: true, sessions: ["review"] };

function parsed(t: test.TestContext, wake: unknown) {
  const { paths } = setup(t, { wake });
  return { paths, policy: readPolicy(paths.policy)! };
}

// One Stop of session SELF at `at`; true when the hook continued the turn.
const stop = (paths: NodePaths, at: number): boolean =>
  deliverForHook({ session_id: SELF, hook_event_name: "Stop", permission_mode: "default" },
    { paths, nonce: () => "t0k3n", replyCommand: "kherep-node", now: () => at }) !== "";

// Listens until a message arriving at the second poll wakes it, or 60 s pass.
const listenFor = (paths: NodePaths, n: number, start: number) =>
  listen(paths, { start, tick: (clock) => { if (clock === start + 2 * WAKE_POLL_MS) arrive(paths, n, clock); } });

test("without wake.budget the defaults stay 6 per hour, 20 per day and 30 s apart", (t) => {
  assert.deepEqual(DEFAULT_TURN_BUDGET, { perHour: TURNS_PER_HOUR, perDay: TURNS_PER_DAY, spacingMs: TURN_SPACING_MS });
  assert.deepEqual(DEFAULT_TURN_BUDGET, { perHour: 6, perDay: 20, spacingMs: 30_000 });
  assert.deepEqual(wakeBudget(DEFAULT_POLICY), DEFAULT_TURN_BUDGET, "no wake section");
  assert.deepEqual(wakeBudget(parsed(t, WAKE).policy), DEFAULT_TURN_BUDGET, "a wake section without budget");
  assert.deepEqual(wakeBudget(parsed(t, { ...WAKE, budget: {} }).policy), DEFAULT_TURN_BUDGET, "an empty budget");
});

test("a configured budget is read, missing fields fall back to the defaults", (t) => {
  const full = parsed(t, { ...WAKE, budget: { perHour: 20, perDay: 100, spacingSeconds: 5 } }).policy;
  assert.deepEqual(full.wake?.budget, { perHour: 20, perDay: 100, spacingSeconds: 5 });
  assert.deepEqual(wakeBudget(full), { perHour: 20, perDay: 100, spacingMs: 5_000 });
  assert.deepEqual(wakeBudget(parsed(t, { ...WAKE, budget: { perHour: 10 } }).policy), { perHour: 10, perDay: 20, spacingMs: 30_000 });
  assert.deepEqual(wakeBudget(parsed(t, { ...WAKE, budget: { perHour: 30 } }).policy), { perHour: 30, perDay: 30, spacingMs: 30_000 },
    "perHour alone raises the default day to at least one hour");
  assert.deepEqual(wakeBudget(parsed(t, { ...WAKE, budget: { spacingSeconds: 3600 } }).policy), { perHour: 6, perDay: 20, spacingMs: 3_600_000 });
  assert.deepEqual(wakeBudget(parsed(t, { ...WAKE, budget: { perHour: 60, perDay: 500 } }).policy), { perHour: 60, perDay: 500, spacingMs: 30_000 });
  assert.deepEqual(wakeBudget(parsed(t, { ...WAKE, budget: { perHour: 1, perDay: 1, spacingSeconds: 5 } }).policy),
    { perHour: 1, perDay: 1, spacingMs: 5_000 });
});

test("an out-of-range, non-integer, inverted or unknown budget rejects the whole wake section", (t) => {
  const rejected: unknown[] = [
    { perHour: 0 }, { perHour: 61, perDay: 100 }, { perDay: 0 }, { perHour: 1, perDay: 501 }, { spacingSeconds: 4 }, { spacingSeconds: 3601 },
    { perHour: 7.5 }, { perHour: "8" }, { perDay: null }, { spacingSeconds: true }, { perHour: Number.NaN /* null after JSON */ },
    { perHour: 10, perDay: 5 }, { perDay: 3 },
    { perHour: 8, extra: 1 }, { perhour: 8 }, { toString: 1 },
    null, [], 8, "fast",
  ];
  for (const budget of rejected) {
    const { paths, policy } = parsed(t, { ...WAKE, codexApp: true, replies: true, budget });
    assert.equal(policy.wake, undefined, JSON.stringify(budget));
    assert.deepEqual(wakeBudget(policy), DEFAULT_TURN_BUDGET, "a rejected section leaves the defaults");
    assert.equal(policy.allowedCommands.length, 0, "the rest of the policy stays");
    const check = checkPolicy(paths.policy).check;
    assert.deepEqual([check.ok, check.wake], [false, { enabled: false, rejected: true }], JSON.stringify(budget));
  }
});

test("takeTurn enforces the budget it is given", (t) => {
  const budget = { perHour: 8, perDay: 9, spacingMs: 5_000 };
  const { paths } = setup(t);
  assert.equal(takeTurn(paths, SELF, T0, budget), "ok");
  assert.equal(takeTurn(paths, SELF, T0 + 4_999, budget), "spacing");
  for (let n = 1; n < 8; n++) assert.equal(takeTurn(paths, SELF, T0 + n * 5_000, budget), "ok", `turn ${n + 1}`);
  assert.equal(takeTurn(paths, SELF, T0 + HOUR - 1, budget), "exhausted", "the hour holds 8");
  assert.equal(takeTurn(paths, SELF, T0 + HOUR, budget), "ok", "the ninth of the day");
  assert.equal(takeTurn(paths, SELF, T0 + 2 * HOUR, budget), "exhausted", "the day holds 9");
});

test("the listener wakes a seventh time in the hour with perHour 8, and honours perDay and spacing", async (t) => {
  // Six turns this hour exhaust the default budget.
  const spend = (paths: NodePaths, from: number, step: number, count = 6): void => {
    for (let n = 0; n < count; n++) assert.equal(takeTurn(paths, SELF, from + n * step), "ok");
  };
  const fallback = setup(t).paths;
  spend(fallback, T0 - 50 * 60_000, 2 * TURN_SPACING_MS);
  assert.deepEqual(await listenFor(fallback, 1, T0), { code: 0 });
  assert.equal(auditLines(fallback).at(-1)?.action, "budget");

  const raised = setup(t, { wake: { ...WAKE, budget: { perHour: 8, perDay: 100 } } }).paths;
  spend(raised, T0 - 50 * 60_000, 2 * TURN_SPACING_MS);
  assert.equal((await listenFor(raised, 1, T0)).code, 2, "the seventh wake");
  assert.equal((await listenFor(raised, 2, T0 + 60_000)).code, 2, "the eighth wake");
  assert.deepEqual(await listenFor(raised, 3, T0 + 2 * 60_000), { code: 0 }, "the ninth is over budget");
  assert.deepEqual(auditLines(raised).map((l) => l.action), ["wake", "wake", "budget"]);

  // perDay 6: six turns hours ago leave none today, though the hour is empty.
  const daily = setup(t, { wake: { ...WAKE, budget: { perDay: 6 } } }).paths;
  spend(daily, T0 - 6 * HOUR, HOUR / 2);
  assert.deepEqual(await listenFor(daily, 1, T0), { code: 0 });
  assert.equal(auditLines(daily).at(-1)?.action, "budget");

  // spacingSeconds 5: a turn just taken delays the wake by 5 s, not 30 s.
  const spaced = setup(t, { wake: { ...WAKE, budget: { spacingSeconds: 5 } } }).paths;
  assert.equal(takeTurn(spaced, SELF, T0 + 2 * WAKE_POLL_MS), "ok");
  assert.equal((await listenFor(spaced, 1, T0)).code, 2);
  const woke = Date.parse(auditLines(spaced).at(-1)?.ts);
  const delay = woke - (T0 + 2 * WAKE_POLL_MS);
  assert.ok(delay >= 5_000 && delay < TURN_SPACING_MS, String(woke - T0));
});

test("the listener follows a budget change at its next poll", async (t) => {
  const { paths } = setup(t);
  for (let n = 0; n < 6; n++) takeTurn(paths, SELF, T0 - 50 * 60_000 + n * 2 * TURN_SPACING_MS);
  const result = await listen(paths, { start: T0, tick: (clock) => {
    if (clock === T0 + 2 * WAKE_POLL_MS) {
      fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [], wake: { ...WAKE, budget: { perHour: 7 } } }));
      arrive(paths, 1, clock);
    }
  } });
  assert.equal(result.code, 2);
});

test("Stop continuations draw on the configured budget", (t) => {
  const { paths } = setup(t, { wake: { ...WAKE, budget: { perHour: 8, perDay: 100, spacingSeconds: 5 } } });
  for (let n = 1; n <= 8; n++) {
    arrive(paths, n, T0);
    assert.equal(stop(paths, T0 + n * 5_000), true, `continuation ${n}`);
  }
  arrive(paths, 9, T0);
  assert.equal(stop(paths, T0 + 9 * 5_000), false);
  assert.deepEqual(auditLines(paths).map((l) => l.action), [...Array(8).fill("continue"), "continue-budget"]);

  // Without the section the hook keeps the default budget: six, 30 s apart.
  const fallback = setup(t, { wake: undefined }).paths;
  arrive(fallback, 1, T0);
  assert.equal(stop(fallback, T0), true);
  arrive(fallback, 2, T0);
  assert.equal(stop(fallback, T0 + 5_000), false, "within the default 30 s");
  assert.deepEqual(auditLines(fallback).map((l) => l.action), ["continue", "continue-budget"]);
  assert.equal(id(2), auditLines(fallback).at(-1)?.messageIds[0]);
});

test("a Stop continuation with an unreadable policy file keeps the default budget", (t) => {
  for (const garbage of ["{ not json", "", "[]", JSON.stringify({ version: 1, wake: { enabled: false, budget: { perHour: 1 } } })]) {
    const { paths } = setup(t, { wake: undefined });
    fs.writeFileSync(paths.policy, garbage);
    arrive(paths, 1, T0);
    assert.equal(stop(paths, T0), true, JSON.stringify(garbage));
    arrive(paths, 2, T0);
    assert.equal(stop(paths, T0 + 5_000), false, "default 30 s spacing: " + JSON.stringify(garbage));
    arrive(paths, 3, T0);
    assert.equal(stop(paths, T0 + 30_000), true, "default spacing passed: " + JSON.stringify(garbage));
  }
});

test("doctor shows the effective budget", (t) => {
  const configured = setup(t, { wake: { ...WAKE, budget: { perHour: 20, spacingSeconds: 10, perDay: 100 } } }).paths;
  assert.deepEqual(checkPolicy(configured.policy).check.wakeBudget, { perHour: 20, perDay: 100, spacingSeconds: 10 });
  const partial = setup(t, { wake: { ...WAKE, budget: { perHour: 10 } } }).paths;
  assert.deepEqual(checkPolicy(partial.policy).check.wakeBudget, { perHour: 10, perDay: 20, spacingSeconds: 30 });
  const none = setup(t, { wake: undefined }).paths;
  assert.deepEqual(checkPolicy(none.policy).check.wakeBudget, { perHour: 6, perDay: 20, spacingSeconds: 30 });
  const rejected = setup(t, { wake: { ...WAKE, budget: { perHour: 61 } } }).paths;
  assert.deepEqual(checkPolicy(rejected.policy).check.wakeBudget, { perHour: 6, perDay: 20, spacingSeconds: 30 });
});

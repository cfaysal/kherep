import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyForkGoalOutcome, classifyOwnerGoalOutcome, FORK_GOAL_EPHEMERAL_PREFIX, type RpcOutcome,
} from "./codex-fork-goal.mts";

// Issue #408, PR 3: the goal revision of 2026-10-16, test cases T1 to T13, T19
// and T20 (the pure decisions; T14 to T18 run against the fake app-server).
// Strings from SOURCE-READ openai/codex 092d3acd, thread_goal_processor.rs.

const FORK = "01a0db74-0000-7000-8000-0000000000f2";
const OTHER = "01a0db74-0000-7000-8000-0000000000f9";
const error = (code: number, message: string): RpcOutcome => ({ kind: "error", code, message });
const result = (value: unknown): RpcOutcome => ({ kind: "result", result: value });
const fork = (outcome: RpcOutcome) => classifyForkGoalOutcome(outcome, FORK, "null");

test("T1 to T4: only the exact ephemeral message with this fork's id passes", () => {
  assert.deepEqual(fork(error(-32600, FORK_GOAL_EPHEMERAL_PREFIX + FORK)), { ok: true, proof: "ephemeral-gate" });
  assert.deepEqual(classifyForkGoalOutcome(error(-32600, FORK_GOAL_EPHEMERAL_PREFIX + FORK), FORK, "complete"),
    { ok: true, proof: "ephemeral-gate" });
  for (const message of [FORK_GOAL_EPHEMERAL_PREFIX + OTHER, `${FORK_GOAL_EPHEMERAL_PREFIX + FORK}\n`, `${FORK_GOAL_EPHEMERAL_PREFIX + FORK} `,
    FORK_GOAL_EPHEMERAL_PREFIX + FORK.toUpperCase(), FORK_GOAL_EPHEMERAL_PREFIX]) {
    assert.deepEqual(fork(error(-32600, message)), { ok: false, detail: "fork-goal-id-mismatch" }, JSON.stringify(message));
  }
  assert.deepEqual(fork(error(-32603, FORK_GOAL_EPHEMERAL_PREFIX + FORK)), { ok: false, detail: "fork-goal-error" }, "the code counts too");
});

// T6 of the revision (goal null accepted behind a switch) is withdrawn: H1 was
// measured, and a maintainer requirement forbids a binary allowlist.
test("T5: goal null for the fork always fails visibly; there is no switch or binary list", () => {
  assert.deepEqual(fork(result({ goal: null })), { ok: false, detail: "fork-goal-null-unexpected" });
  assert.deepEqual(classifyForkGoalOutcome(result({ goal: null }), FORK, "complete"), { ok: false, detail: "fork-goal-null-unexpected" });
  assert.deepEqual(classifyForkGoalOutcome(result({ goal: null }), FORK, undefined), { ok: false, detail: "fork-goal-inconsistent" },
    "never without a successful owner read");
});

test("T7 to T9: any goal object or other shape fails", () => {
  for (const status of ["active", "complete"]) {
    assert.deepEqual(fork(result({ goal: { threadId: FORK, status, objective: "x" } })), { ok: false, detail: "fork-has-goal" }, status);
  }
  for (const value of [{}, { goal: null, extra: 1 }, null, "goal", [], { goal: 1 }]) {
    assert.deepEqual(fork(result(value)), { ok: false, detail: "fork-goal-shape" }, JSON.stringify(value));
  }
});

test("T10 to T13: disabled goals, other codes and other messages fail; timeout and transport are their own codes", () => {
  assert.deepEqual(fork(error(-32600, "goals feature is disabled")), { ok: false, detail: "fork-goal-inconsistent" });
  assert.deepEqual(fork(error(-32601, "method not found")), { ok: false, detail: "fork-goal-error" });
  assert.deepEqual(fork(error(-32603, "sqlite state db unavailable for thread goals")), { ok: false, detail: "fork-goal-error" });
  assert.deepEqual(fork(error(-32600, `thread not found: ${FORK}`)), { ok: false, detail: "fork-goal-error" });
  assert.deepEqual(fork({ kind: "timeout" }), { ok: false, detail: "fork-goal-timeout" });
  assert.deepEqual(fork({ kind: "transport" }), { ok: false, detail: "fork-goal-transport" });
});

test("T19: the pre-fork owner outcomes", () => {
  const owner = "01a0db74-0000-7000-8000-0000000000f1";
  const cases: [RpcOutcome, unknown][] = [
    [result({ goal: null }), { ok: true, outcome: "null" }],
    [result({ goal: { status: "complete" } }), { ok: true, outcome: "complete" }],
    ...["active", "paused", "blocked", "usageLimited", "budgetLimited", "somethingNew"].map((status) =>
      [result({ goal: { status } }), { ok: false, reason: "owner-goal" }] as [RpcOutcome, unknown]),
    [error(-32600, "goals feature is disabled"), { ok: false, reason: "goals-disabled" }],
    [error(-32600, "goals feature is disabled "), { ok: false, reason: "goal-unknown" }],
    [error(-32603, "failed to locate thread id"), { ok: false, reason: "goal-unknown" }],
    [error(-32600, `thread not found: ${owner}`), { ok: false, reason: "goal-unknown" }],
    [result({}), { ok: false, reason: "goal-unknown" }], [result(null), { ok: false, reason: "goal-unknown" }],
    [result({ goal: 1 }), { ok: false, reason: "goal-unknown" }], [result({ goal: {} }), { ok: false, reason: "goal-unknown" }],
    [{ kind: "timeout" }, { ok: false, reason: "goal-unknown" }], [{ kind: "transport" }, { ok: false, reason: "goal-unknown" }],
  ];
  for (const [outcome, expected] of cases) assert.deepEqual(classifyOwnerGoalOutcome(outcome), expected, JSON.stringify(outcome));
});

test("T20: the fork decision is pure, the same inputs give the same result", () => {
  const inputs: RpcOutcome[] = [error(-32600, FORK_GOAL_EPHEMERAL_PREFIX + FORK), result({ goal: null }), { kind: "timeout" }];
  for (const input of inputs) {
    const frozen = Object.freeze({ ...input }) as RpcOutcome;
    assert.deepEqual(fork(frozen), fork(frozen));
    assert.deepEqual(frozen, input, "the input is not changed");
  }
});

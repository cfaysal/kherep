import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import type { TaskRuntime } from "../protocol-tasks.mts";
import { listenerDir, takeTurn } from "./autonomy.mts";
import { deliverToClosed } from "./closed-delivery.mts";
import { audits, SESSION } from "./closed-fixture.mts";
import { runs } from "./closed-resume-fault-fixture.mts";
import { getMessage, getMessageProgress, writeJsonAtomic } from "./inbox.mts";
import { DEFAULT_TURN_BUDGET } from "./policy.mts";
import type { Readiness, Verdict } from "./runtime-readiness.mts";
import { CONTROL, storedSource, type StoredSource } from "./session-id-fixture.mts";
import { listTasks, readTask, writeTask } from "./task-records.mts";

// Issue #639, R4 guard controls: excluding a malformed stored source from
// reuse bypasses none of the guards of the guarded new path on the closed
// target S0, and none before it; an active or still-running task keeps the
// earlier branch. Synthetic ids, a fake claude, no real process probe.
type Setup = Awaited<ReturnType<typeof storedSource>>;

// Nothing ran and nothing was attempted: M waits (or is refused) with code.
function assertHeld(s: Setup, code: string, locks: string[] = []): void {
  assert.deepEqual(s.locks, locks, "no budget lock beyond the expected ones");
  assert.deepEqual(runs(s.node), ["--bg"], "no native start or resume");
  const message = getMessage(s.node.paths.inbox, s.id)!;
  assert.deepEqual([message.closedAttempt, message.offers, message.toSession], [undefined, undefined, SESSION], "no attempt");
  assert.equal(getMessageProgress(s.node.paths.inbox, s.id)?.code, code);
  assert.equal(listTasks(s.node.paths).length, 1, "no new task");
}

async function held(t: test.TestContext, options: StoredSource = {}, prepare: (s: Setup) => void = () => {}): Promise<Setup> {
  const s = await storedSource(t, CONTROL, options);
  prepare(s);
  await deliverToClosed(s.listing.deps);
  return s;
}

test("S0 budget spacing keeps M waiting; the bad stored id is never a key", async (t) => {
  const s = await held(t, {}, (s) => assert.equal(takeTurn(s.node.paths, SESSION, s.node.deps().now!()), "ok"));
  assertHeld(s, "retry-pending", [SESSION, SESSION]);
});

test("an exhausted S0 budget refuses for now; no start, no attempt", async (t) => {
  const s = await held(t, {}, (s) => {
    const now = s.node.deps().now!();
    const turns = Array.from({ length: DEFAULT_TURN_BUDGET.perHour }, (_, i) => now - 3_000_000 + i * 60_000);
    writeJsonAtomic(path.join(listenerDir(s.node.paths), `${SESSION}.turns.json`), { turns });
  });
  assertHeld(s, "budget-exhausted", [SESSION]);
});

test("a failing S0 budget lock keeps M waiting; the lock failure is not bypassed", async (t) => {
  const s = await held(t, { fail: (file) => path.basename(file).startsWith(SESSION) ? "EIO" : null });
  assertHeld(s, "retry-pending", [SESSION]);
});

// The old ended task is a codex task in another valid cwd; the closed target
// S0 is claude in workspace/repo. Both runtimes are enabled, so the earlier
// allowlist passes and only the readiness probe can tell them apart.
async function codexSource(t: test.TestContext, verdict: Verdict | null) {
  const probed: TaskRuntime[] = [];
  const peek = (runtime: TaskRuntime) => (probed.push(runtime), verdict);
  const readiness = { peek, check: async (runtime: TaskRuntime) => peek(runtime) } as unknown as Readiness;
  const s = await storedSource(t, CONTROL, { sessions: { runtimes: ["claude", "codex"] } });
  writeTask(s.node.paths, { ...readTask(s.node.paths, s.task.taskId)!, runtime: "codex", cwd: s.node.workspace });
  await deliverToClosed({ ...s.listing.deps, readiness });
  return { s, probed };
}

for (const [name, cause] of [["pending", null], ["sign-in", "sign-in"]] as const) {
  test(`original-target readiness ${name} is probed for the target's runtime, not the old codex task's`, async (t) => {
    const { s, probed } = await codexSource(t, cause ? { ready: false, at: 0, cause } : null);
    assert.deepEqual(probed, ["claude"], "probed for found.runtime only");
    assert.deepEqual(s.locks, [], "no budget");
    assert.deepEqual(runs(s.node), ["--bg"], "no native start");
    const message = getMessage(s.node.paths.inbox, s.id)!;
    assert.equal(message.closedAttempt, undefined, "no attempt mark");
    if (cause) assert.deepEqual([message.state, audits(s.node).at(-1)?.outcome], ["refused", "refused"]);
    else assert.deepEqual([message.state, getMessageProgress(s.node.paths.inbox, s.id)?.code], ["accepted", "retry-pending"]);
  });
}

test("a ready target starts its own runtime in its own cwd, not the old codex task's", async (t) => {
  const { s, probed } = await codexSource(t, { ready: true, at: 0 });
  assert.deepEqual([...new Set(probed)], ["claude"], "the old task's runtime is never probed");
  assert.deepEqual([s.locks, runs(s.node)], [[SESSION], ["--bg", "--bg"]], "S0 budget, one new start");
  const fresh = listTasks(s.node.paths).find((r) => r.taskId !== s.task.taskId)!;
  const repo = fs.realpathSync.native(path.join(s.node.workspace, "repo"));
  assert.deepEqual([fresh.runtime, fresh.cwd], ["claude", repo]);
  assert.equal(s.node.calls.filter((c) => c.args[0] === "--bg").at(-1)?.options.cwd, repo);
});

test("the full new-start limit counts the old task; no continue exception", async (t) => {
  const s = await held(t, { sessions: { maxStartsPerDay: 1 } });
  assertHeld(s, "retry-pending");
  assert.match(String(audits(s.node).at(-1)?.reason), /at most 1 task sessions per day/);
});

test("an operator-stopped intercom task keeps its earlier refusal", async (t) => {
  const s = await held(t, { extra: { operatorStoppedAt: new Date(0).toISOString() } });
  assertHeld(s, "operator-stopped");
});

test("an active task with a valid id keeps the same-task reuse, without budget or new run", async (t) => {
  const valid = "5e55b0000000-0000-4000-8000-000000000000";
  const s = await storedSource(t, valid, { extra: { state: "running" } });
  await deliverToClosed(s.listing.deps);
  assert.deepEqual([s.locks, runs(s.node)], [[], ["--bg"]]);
  const message = getMessage(s.node.paths.inbox, s.id)!;
  assert.deepEqual([message.toSession, message.closedTo, message.delivery],
    [valid, SESSION, { taskId: s.task.taskId, runtime: "claude", sessionId: valid }]);
  assert.deepEqual([audits(s.node).at(-1)?.outcome, audits(s.node).at(-1)?.reason], ["reused", "intercom session running"]);
});

test("an ended task with a bad id whose process still runs keeps the earlier branch and its attachment failure", async (t) => {
  const s = await storedSource(t, CONTROL, { extra: { pid: 4_500_000, pidStart: "s5" } });
  const lines: string[] = [];
  const codex = { processStart: (pid: number) => pid === 4_500_000 ? "s5" : null };
  await deliverToClosed({ ...s.listing.deps, codex }, (l) => lines.push(l));
  assert.deepEqual([s.locks, runs(s.node), listTasks(s.node.paths).length], [[], ["--bg"], 1], "no budget, no replacement start");
  assert.ok(lines.some((l) => l.includes("could not deliver to closed session") && l.includes("invalid delivery task identity")));
  assert.ok(!lines.some((l) => l.includes(CONTROL)));
  assert.equal(getMessage(s.node.paths.inbox, s.id)?.closedAttempt, undefined);
});

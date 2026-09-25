import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

import { parentWatch, takeTurn, TURN_SPACING_MS, TURNS_PER_DAY, TURNS_PER_HOUR, wakeAudit } from "./autonomy.mts";
import { deliverForHook } from "./deliver-hook.mts";
import { getMessage } from "./inbox.mts";
import { arrive, auditLines, id, listen, SECRET, SELF, setup, T0 } from "./wake-fixture.mts";
import { WAKE_POLL_MS } from "./wake-hook.mts";

// The autonomy budget and permission gate (issue #31, operator decisions of
// 2026-09-25): wakes and Stop continuations share one budget per session.

const HOUR = 60 * 60_000;
const REPLY = 'node "/opt/kherep/modules/control-plane/node/cli.mts"';

// One Stop of session SELF at `at`; the additionalContext or "".
function stop(paths: Parameters<typeof takeTurn>[0], at: number, mode = "default"): string {
  const output = deliverForHook({ session_id: SELF, hook_event_name: "Stop", permission_mode: mode },
    { paths, nonce: () => "t0k3n", replyCommand: REPLY, now: () => at });
  return output ? JSON.parse(output).hookSpecificOutput.additionalContext as string : "";
}

test(`takeTurn allows ${TURNS_PER_HOUR} per rolling hour, ${TURNS_PER_DAY} per rolling day and one per ${TURN_SPACING_MS / 1000} s`, (t) => {
  const { paths } = setup(t);
  assert.equal(takeTurn(paths, SELF, T0), "ok");
  assert.equal(takeTurn(paths, SELF, T0 + TURN_SPACING_MS - 1), "spacing");
  for (let n = 1; n < TURNS_PER_HOUR; n++) assert.equal(takeTurn(paths, SELF, T0 + n * TURN_SPACING_MS), "ok", `turn ${n + 1}`);
  assert.equal(takeTurn(paths, SELF, T0 + HOUR - 1), "exhausted");
  // Rolling: the first turn leaves the hour window exactly one hour later.
  assert.equal(takeTurn(paths, SELF, T0 + HOUR), "ok");

  // 11 minutes apart the hour never fills; the day does after 20 turns.
  const daily = setup(t).paths;
  for (let n = 0; n < TURNS_PER_DAY; n++) assert.equal(takeTurn(daily, SELF, T0 + n * 11 * 60_000), "ok", `turn ${n + 1}`);
  assert.equal(takeTurn(daily, SELF, T0 + 24 * HOUR - 1), "exhausted");
  assert.equal(takeTurn(daily, SELF, T0 + 24 * HOUR), "ok");
});

test("Stop continuations consume the budget; when it is exhausted Stop offers nothing and says so in the audit", (t) => {
  const { paths } = setup(t);
  for (let n = 1; n <= TURNS_PER_HOUR; n++) {
    arrive(paths, n, T0);
    assert.match(stop(paths, T0 + n * TURN_SPACING_MS), new RegExp(`=== Kherep peer message ${id(n)} `), `continuation ${n}`);
  }
  arrive(paths, 7, T0);
  assert.equal(stop(paths, T0 + 7 * TURN_SPACING_MS), "");
  assert.equal(getMessage(paths.inbox, id(7))?.state, "accepted", "it waits for the next user prompt");
  assert.deepEqual(auditLines(paths).map((l) => l.action), [...Array(TURNS_PER_HOUR).fill("continue"), "continue-budget"]);
  assert.deepEqual(auditLines(paths).at(-1)?.messageIds, [id(7)]);
  assert.ok(!fs.readFileSync(wakeAudit(paths), "utf8").includes(SECRET), "the audit never carries message text");
  // A prompt of the user is not autonomous: it delivers regardless of the budget.
  assert.match(deliverForHook({ session_id: SELF, hook_event_name: "UserPromptSubmit" }, { paths, now: () => T0 + HOUR / 2 }), /Kherep/);
});

test("wakes and Stop continuations draw on the same budget", async (t) => {
  const { paths } = setup(t);
  for (let n = 1; n < TURNS_PER_HOUR; n++) assert.equal(takeTurn(paths, SELF, T0 - HOUR / 2 + n * TURN_SPACING_MS), "ok");
  arrive(paths, 1, T0);
  assert.notEqual(stop(paths, T0), "", "the last turn of the hour");
  assert.deepEqual(await listen(paths, { start: T0 + TURN_SPACING_MS, tick: (clock) => {
    if (clock === T0 + TURN_SPACING_MS + 2 * WAKE_POLL_MS) arrive(paths, 2, clock);
  } }), { code: 0 });
  assert.deepEqual(auditLines(paths).map((l) => l.action), ["continue", "budget"]);
});

test("bypassPermissions: no Stop continuation, while the user's own prompt still delivers", (t) => {
  const { paths } = setup(t);
  const messageId = arrive(paths, 1, T0);
  assert.equal(stop(paths, T0, "bypassPermissions"), "");
  assert.equal(getMessage(paths.inbox, messageId)?.state, "accepted");
  assert.deepEqual(auditLines(paths).map((l) => [l.action, l.messageIds]), [["continue-permission-mode", [messageId]]]);
  const prompt = deliverForHook({ session_id: SELF, hook_event_name: "UserPromptSubmit", permission_mode: "bypassPermissions" }, { paths });
  assert.match(prompt, new RegExp(messageId));
  for (const mode of ["default", "acceptEdits", "plan", "auto", "dontAsk"]) {
    const other = setup(t).paths;
    arrive(other, 1, T0);
    assert.notEqual(stop(other, T0, mode), "", mode);
  }
});

test("parentWatch: the starting process alive, a finished one gone", () => {
  assert.equal(parentWatch()(), true);
  assert.equal(parentWatch(1)(), true, "pid 1 cannot be watched");
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  assert.equal(parentWatch(Number(child.stdout))(), false);
});

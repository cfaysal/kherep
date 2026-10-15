import assert from "node:assert/strict";
import test from "node:test";

import { rememberMode } from "./autonomy.mts";
import { storeMessage } from "./inbox.mts";
import { wakeText } from "./wake-hook.mts";
import { auditLines, id, listen, PEER, SELF, setup, T0 } from "./wake-fixture.mts";

// Issue #414: the receiver's Claude wake decision depends on the accepted
// message and the receiver's guards, not on whether the caller session id looks
// like a Claude or Codex UUID. These are synthetic ids, not runtime evidence.
const CALLERS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];

function accepted(paths: ReturnType<typeof setup>["paths"], fromSession: string, n: number, receivedAt = T0): string {
  const messageId = id(n);
  storeMessage(paths.inbox, {
    messageId, from: { nodeId: PEER, session: fromSession }, toSession: "review",
    text: "synthetic peer message", createdAt: new Date(receivedAt).toISOString(),
  }, receivedAt);
  return messageId;
}

async function decisions(t: test.TestContext, fromSession: string) {
  const wildcard = setup(t, { wake: { enabled: true, sessions: ["*"] } }).paths;
  rememberMode(wildcard, SELF, "default");
  accepted(wildcard, fromSession, 1);
  const wildcardStart = await listen(wildcard, {
    event: "SessionStart", source: "resume", mode: null,
    launch: async () => assert.fail("wildcard-only restart must not inspect launch mode"),
    tick: () => assert.fail("wildcard-only restart must not arm"),
  });

  const exact = setup(t, { wake: { enabled: true, sessions: [SELF] } }).paths;
  rememberMode(exact, SELF, "default");
  accepted(exact, fromSession, 2);
  const exactStart = await listen(exact, { event: "SessionStart", source: "resume", mode: null, launch: async () => "ok" });

  const unknown = setup(t, { wake: { enabled: true, sessions: [SELF] } }).paths;
  accepted(unknown, fromSession, 3);
  const unknownStart = await listen(unknown, {
    event: "SessionStart", source: "resume", mode: null,
    launch: async () => assert.fail("an unknown mode must not inspect launch mode"),
    tick: () => assert.fail("an unknown mode must not arm"),
  });

  const bypass = setup(t, { wake: { enabled: true, sessions: [SELF] } }).paths;
  rememberMode(bypass, SELF, "bypassPermissions");
  accepted(bypass, fromSession, 4);
  const bypassStart = await listen(bypass, {
    event: "SessionStart", source: "resume", mode: null,
    launch: async () => assert.fail("bypass mode must not inspect launch mode"),
    tick: () => assert.fail("bypass mode must not arm"),
  });

  const stop = setup(t, { wake: { enabled: true, sessions: ["*"] } }).paths;
  let stopMessage = false;
  const permissionBearingStop = await listen(stop, { event: "Stop", mode: "default", tick: (clock) => {
    if (!stopMessage && clock >= T0 + 4_000) {
      accepted(stop, fromSession, 5, clock);
      stopMessage = true;
    }
  } });

  return {
    wildcardStart, wildcardActions: auditLines(wildcard).map((line) => line.action),
    exactStart, exactActions: auditLines(exact).map((line) => line.action),
    unknownStart, unknownActions: auditLines(unknown).map((line) => line.action),
    bypassStart, bypassActions: auditLines(bypass).map((line) => line.action),
    permissionBearingStop, stopActions: auditLines(stop).map((line) => line.action),
  };
}

test("synthetic Claude and Codex caller ids produce the same guarded receiver decisions", async (t) => {
  const results = [];
  for (const caller of CALLERS) results.push(await decisions(t, caller));
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[0], {
    wildcardStart: { code: 0 }, wildcardActions: ["permission-mode-unknown"],
    exactStart: { code: 2, text: wakeText(1) }, exactActions: ["backlog"],
    unknownStart: { code: 0 }, unknownActions: ["permission-mode-unknown"],
    bypassStart: { code: 0 }, bypassActions: ["permission-mode"],
    permissionBearingStop: { code: 2, text: wakeText(1) }, stopActions: ["wake"],
  });
});

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import type { SessionStartArgs } from "../protocol-tasks.mts";
import { readConfig } from "./config.mts";
import { commandHandlers } from "./daemon.mts";
import { startArgs, TASK, taskNode } from "./task-fixture.mts";

// Issue #463: the session commands take their runner, and with it the policy,
// per command (the fixture's deps() reads the policy file at each call), so a
// tightened sessions section applies to the next command without a restart.

test("session.start follows a sessions.runtimes edit made after the handlers were built", async (t) => {
  const node = taskNode(t, { runtimes: ["claude", "codex"] });
  const config = readConfig(node.paths.config);
  assert.ok(config);
  const handlers = commandHandlers(config, 0, async () => [], node.deps);
  const policy = JSON.parse(fs.readFileSync(node.paths.policy, "utf8")) as { sessions: Record<string, unknown> };
  fs.writeFileSync(node.paths.policy, JSON.stringify({ ...policy, sessions: { ...policy.sessions, runtimes: ["claude"] } }));
  // The client hands each handler its validated args; CommandHandlers types them as never.
  const start = handlers["session.start"] as ((args: SessionStartArgs) => Promise<unknown>) | undefined;
  assert.ok(start);
  await assert.rejects(start(startArgs(TASK, { runtime: "codex" })), /runtime codex is not supported/);
  assert.equal(node.calls.length, 0, "nothing was started");
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeEnvelope } from "../protocol.mts";
import { nodePaths } from "./config.mts";
import { routeFrame } from "./readiness-lane.mts";

// Issue #441: one parse decides the lane of an inbound frame.

const paths = nodePaths(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-readiness-lane-")));
test.after(() => fs.rmSync(paths.dir, { recursive: true, force: true }));

const delivery = JSON.stringify(makeEnvelope("message.deliver", { messageId: "00000000-0000-4000-8000-000000000001",
  from: { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "synthetic-peer" }, toSession: "synthetic-session",
  text: "synthetic", createdAt: new Date(0).toISOString() }, 0, 0));
const command = (name: string, args?: Record<string, unknown>): string =>
  JSON.stringify(makeEnvelope("command", { commandId: "c1", command: name, ...(args ? { args } : {}) }, 1, 0, "c1"));

test("a message.deliver frame routes as deliver", () => {
  assert.deepEqual(routeFrame(delivery, paths), { kind: "deliver" });
});

test("an unparseable frame and any other envelope route as other", () => {
  assert.deepEqual(routeFrame("not json", paths), { kind: "other" });
  assert.deepEqual(routeFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)), paths), { kind: "other" });
});

test("commands keep their runtime", () => {
  assert.deepEqual(routeFrame(command("session.start", { runtime: "codex" }), paths), { kind: "command", runtime: "codex" });
  assert.deepEqual(routeFrame(command("node.status"), paths), { kind: "command", runtime: null });
  assert.deepEqual(routeFrame(command("session.continue", { taskId: "3f2a1b0c-0000-4000-8000-000000000001" }), paths),
    { kind: "command", runtime: null }, "a task this node does not keep has no runtime");
});

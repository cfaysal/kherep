import assert from "node:assert/strict";
import test from "node:test";

import { deliverToClosed } from "./closed-delivery.mts";
import { closedNode, COPY, copyingExec, endedIntercom } from "./closed-fixture.mts";
import { resumeClaude, resumeCodex } from "./closed-resume.mts";
import { defaultServiceOwnerProbe, type ServiceOwnerProbe } from "./service-drain.mts";
import { continueTask, startTask, stopTask } from "./session-runner.mts";
import { startArgs, TASK, taskNode } from "./task-fixture.mts";
import { listTasks } from "./task-records.mts";

// Issue #423: the service admission of a start, a continue or a resume asks
// the owner probe of the runner deps, never the default one, whose Windows
// identity lookup starts PowerShell and may time out on a loaded runner. The
// task fixture injects a probe that starts no process. In closed-copy.test.mts
// the first admission of the test process is startTask inside endedIntercom
// (closed-fixture.mts), not the resume: when it timed out, no task record was
// written, and the next delivery started a new intercom session (--bg)
// instead of resuming one. So the default is broken before endedIntercom.

const UNVERIFIED = "service controller identity cannot be verified";
const failing: ServiceOwnerProbe = { current: () => { throw new Error("owner probe unavailable"); }, active: () => "unknown" };

// The default probe as it fails when its PowerShell start times out; the
// test asserts it is never asked, so a fallback that swallows it still fails.
const breakDefault = (t: test.TestContext) =>
  t.mock.method(defaultServiceOwnerProbe, "current", () => { throw new Error(UNVERIFIED); });

test("a resume is admitted by the injected owner probe", async (t) => {
  const node = closedNode(t);
  const { task } = await endedIntercom(node);
  const deps = { ...node.deps(), serviceOwner: failing };
  assert.equal(await resumeClaude(deps, task, task.cwd, 1, Date.now()), "owner probe unavailable");
  assert.equal(await resumeCodex(deps, task, task.cwd, 1, Date.now()), "owner probe unavailable");
  assert.equal(node.calls.filter((c) => c.args[0] === "--resume").length, 0, "claude --resume is never called");
});

test("a copy made on resume is adopted while the default owner probe fails", async (t) => {
  const current = breakDefault(t);
  const node = closedNode(t);
  await endedIntercom(node);
  const fake = copyingExec(node, false, () => {});
  await deliverToClosed(fake.deps);
  assert.deepEqual(node.calls.filter((c) => c.args[0] !== "agents").map((c) => c.args[0]), ["--bg", "--resume"]);
  assert.equal(listTasks(node.paths)[0].sessionId, COPY);
  assert.equal(current.mock.callCount(), 0);
});

test("a task starts and continues while the default owner probe fails", async (t) => {
  const current = breakDefault(t);
  const node = taskNode(t);
  assert.equal((await startTask(startArgs(), node.deps())).state, "started");
  await stopTask({ taskId: TASK }, node.deps());
  assert.equal((await continueTask({ taskId: TASK, prompt: "one more thing" }, node.deps())).state, "started");
  assert.equal(current.mock.callCount(), 0);
});

import assert from "node:assert/strict";
import test from "node:test";

import { audits } from "./closed-fixture.mts";
import { deliverToClosed } from "./closed-delivery.mts";
import { resumeClaude } from "./closed-resume.mts";
import { copyOutput, resumeNode, resumingExec, runs, type Resume } from "./closed-resume-fault-fixture.mts";
import { readTask, writeTask } from "./task-records.mts";

// Issue #638: the failed-resume branches keep their reason and the guarded
// fallback start, also when their own cleanup or the admission release fails;
// an empty listed id keeps the ordinary missing-mapping path. Synthetic only.
const NO_ID = "resumed without a background line\n";

const legacy: { label: string; resume: Resume; stopped: boolean }[] = [
  { label: "no printed short id, restore write error", resume: { output: NO_ID, fault: "task-write" }, stopped: false },
  { label: "no printed short id, release error", resume: { output: NO_ID, fault: "release" }, stopped: false },
  { label: "unlisted note copy, release error", resume: { output: copyOutput(true), listed: null, fault: "release" }, stopped: true },
  { label: "note copy without a full id, restore write error", resume: { output: copyOutput(true), restoreFault: true },
    stopped: true },
];
for (const { label, resume, stopped } of legacy) {
  test(`a failed resume (${label}) still falls back to a guarded new start`, async (t) => {
    const { node } = await resumeNode(t);
    const { deps, events } = resumingExec(t, node, resume);
    const lines: string[] = [];
    await deliverToClosed({ ...deps, log: (l) => lines.push(l) }, (l) => lines.push(l));
    const fault = resume.restoreFault ? "task-write" : resume.fault!;
    assert.deepEqual(events, ["resume", ...(stopped ? ["stop c0ffee01"] : []), `${fault}-fault`]);
    assert.deepEqual(runs(node), ["--bg", "--resume", ...(stopped ? ["stop"] : []), "--bg"], "one fallback start");
    assert.ok(!lines.some((l) => l.includes("could not deliver")));
    const last = audits(node).at(-1)!;
    assert.equal(last.outcome, "new");
    assert.match(String(last.reason), /^intercom session not resumed: /);
  });
}

test("a direct resume that printed no short id returns its reason despite a release error", async (t) => {
  const { node, task } = await resumeNode(t);
  const { deps } = resumingExec(t, node, { output: NO_ID, fault: "release" });
  const reason = await resumeClaude(deps, task, task.cwd, 1, deps.now!());
  assert.equal(typeof reason, "string");
});

for (const note of [true, false]) {
  test(`an empty listed full id ${note ? "with" : "without"} a note keeps the old id pending; no fallback`, async (t) => {
    const { node, task } = await resumeNode(t);
    const { deps } = resumingExec(t, node, { output: copyOutput(note), listed: "" });
    await deliverToClosed(deps);
    const saved = readTask(node.paths, task.taskId)!;
    assert.deepEqual([saved.sessionId, saved.shortId, saved.state], [task.sessionId, "c0ffee01", "started"]);
    assert.ok(saved.mappingPendingSince);
    assert.deepEqual(runs(node), ["--bg", "--resume"]);
  });
}

test("a malformed stored source id is not resumed; the guarded fallback starts a new session", async (t) => {
  const { node, task } = await resumeNode(t);
  // Overlong rather than a control character: the turn budget keys a file by
  // this id, and Windows refuses a newline in a file name.
  writeTask(node.paths, { ...readTask(node.paths, task.taskId)!, sessionId: "a".repeat(129) });
  const { deps } = resumingExec(t, node, { output: copyOutput(true), listed: "c0ffee00-0000-4000-8000-000000000001" });
  await deliverToClosed(deps);
  assert.deepEqual(runs(node), ["--bg", "--bg"], "no native resume of a malformed id");
  assert.equal(audits(node).at(-1)?.outcome, "new");
});

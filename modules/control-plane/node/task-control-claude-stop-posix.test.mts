import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

import type { TaskControlExecuteBody } from "../protocol-task-control.mts";
import { processStart, signalGroup, signalProcess, type CodexDeps, type SignalScope } from "./codex-process.mts";
import { executeTaskControl } from "./task-control-local.mts";
import { taskNode, TASK, T0 } from "./task-fixture.mts";
import { writeTask } from "./task-records.mts";

// Issue #437, PR 2 with real processes: the session process (root) starts a
// shell command in its own process group, as Claude Code's Bash tool does.
// The fake `claude stop` ends the root only, the way the measured `claude
// stop` ends the session and leaves a running shell command alive. The
// confirmed stop still ends the child, by its own pid; the node never
// signals the root. Only processes this test spawned are signalled.
const CHILD = `const c = require("node:child_process").spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
console.log(c.pid);
setInterval(() => {}, 1000);`;

const OWNER = "00000000-0000-4000-8000-0000000000bb";
const TARGET = "00000000-0000-4000-8000-0000000000aa";
const SOURCE = "30000000-0000-4000-8000-000000000001";
const SHORT = "b0000001";
const SESSION = "5e55b000-0000-4000-8000-000000000001";

const operation = (action: "status" | "stop", expectedRunVersion?: string): TaskControlExecuteBody => ({
  name: "task.control.execute", operationId: crypto.randomUUID(), requestId: crypto.randomUUID(), taskId: TASK, action,
  ownerNodeId: OWNER, targetNodeId: TARGET, runtime: "claude", origin: { kind: "source-request", sourceRequestId: SOURCE },
  grantVersion: 1, ...(expectedRunVersion ? { expectedRunVersion } : {}),
});

async function session(t: test.TestContext) {
  const root = spawn(process.execPath, ["-e", CHILD], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const [line] = await once(root.stdout!, "data") as [Buffer];
  const child = Number(line.toString().trim());
  t.after(() => {
    for (const pid of [child, root.pid!]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already ended
      }
    }
  });
  assert.ok(Number.isInteger(child) && child > 0);
  return { root: root.pid!, child };
}

for (const spy of [false, true]) {
  test(`a confirmed Claude stop ends a shell command that outlives claude stop${spy ? ", by its own pid only" : ""} (issue #437)`,
    { skip: process.platform === "win32" ? "POSIX process groups" : false }, async (t) => {
      const { root, child } = await session(t);
      const childStart = processStart(child);
      assert.notEqual(childStart, null);
      const node = taskNode(t, { runtimes: ["claude"], ownTaskControl: true });
      const rootStart = processStart(root);
      const stops: string[] = [];
      const exec = async (_file: string, args: string[]): Promise<string> => {
        if (args[0] === "stop") {
          stops.push(args[1]);
          process.kill(root, "SIGTERM");
          return "";
        }
        const live = processStart(root) === rootStart;
        return JSON.stringify([{ id: SHORT, kind: "background", sessionId: SESSION, name: "task-3f2a1b0c",
          ...(live ? { state: "working", pid: root, status: "busy" } : { state: "stopped" }) }]);
      };
      const signals: [number, NodeJS.Signals, SignalScope | undefined][] = [];
      const codex: CodexDeps = { graceMs: 3_000, ...(spy ? { signal: (pid, signal, scope) => {
        signals.push([pid, signal, scope]);
        if (scope === "process") signalProcess(pid, signal);
        else signalGroup(pid, signal);
      } } : {}) };
      writeTask(node.paths, { taskId: TASK, runtime: "claude", name: "task-3f2a1b0c", cwd: node.workspace, permissionMode: "auto",
        state: "running", startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 60 * 60_000).toISOString(),
        updatedAt: new Date(T0).toISOString(), requestedBy: `${OWNER}/owner-session`, sourceRequestId: SOURCE, shortId: SHORT,
        sessionId: SESSION });
      const context = { nodeId: TARGET, paths: node.paths, now: () => T0, runner: { ...node.deps(), exec, codex } };
      const status = await executeTaskControl(operation("status"), context);
      assert.deepEqual([status.processState, status.stopSupported], ["running", true]);
      const result = await executeTaskControl(operation("stop", status.runVersion), context);
      assert.deepEqual([result.state, result.stopConfirmed, result.processState, result.errorCode], ["succeeded", true, "closed", undefined]);
      assert.notEqual(processStart(child), childStart);
      assert.deepEqual(stops, [SHORT]);
      if (spy) {
        assert.ok(signals.length > 0 && signals.every(([pid, , scope]) => pid === child && scope === "process"), JSON.stringify(signals));
      }
    });
}

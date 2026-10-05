import { describe, expect, it, vi } from "vitest";

import { runTaskControlArgs } from "../../node/task-control-cli.mts";
import { resolveTaskDetail } from "../../node/task-detail.mts";
import { readRequest, readTask, writeRequest } from "../../node/task-records.mts";
import { readRefusal } from "../../node/task-refusals.mts";
import { startTaskNode, WAIT } from "./task-helpers.mts";

// Issue #240: a delegated start the target refuses (here an MSYS-rewritten
// Windows cwd sent to a POSIX node) is logged on the target, and the
// requester's `task status` shows the failed state with the target's reason
// instead of task_unknown under a frozen "dispatched".
describe("a refused delegated start", () => {
  it("reaches the requester's task status with its reason", async () => {
    const os = `refusal-${crypto.randomUUID()}`;
    const target = await startTaskNode(`target-${os}`, { os, sessions: { enabled: true, delegate: { accept: true }, ownTaskControl: true } });
    const maestro = await startTaskNode(`maestro-${os}`, { sessions: { enabled: true, delegate: { request: true }, ownTaskControl: true } });
    const requestId = crypto.randomUUID();
    writeRequest(maestro.paths, { requestId, title: "intercom: claude@maestro", text: "PRIVATE_SENTINEL probe",
      requirements: { runtime: "claude", node: target.nodeId, cwd: "C:/Program Files/Git/Users/a/probe-198" },
      directive: "start it there", requestedBy: "maestro", createdAt: new Date().toISOString(), state: "pending" });
    await maestro.exchange();
    await vi.waitFor(() => expect(readRequest(maestro.paths, requestId)?.state).toBe("dispatched"), WAIT);
    const taskId = readRequest(maestro.paths, requestId)!.taskId!;

    // The target refuses during admission: logged, no task record, a refusal record, a failed report.
    await vi.waitFor(() => expect(target.logs).toContain(`kherep-node: task ${taskId} refused: cwd must be an absolute path`), WAIT);
    await target.idle();
    expect(target.logs.some((line) => line.includes(`for task ${taskId} failed: cwd must be an absolute path`))).toBe(true);
    expect(target.logs.join("\n")).not.toContain("PRIVATE_SENTINEL");
    expect(readTask(target.paths, taskId)).toBeNull();
    expect(readRefusal(target.paths, taskId)?.state).toBe("failed");
    expect(target.calls).toEqual([]);
    await target.exchange();

    const out: string[] = [];
    const code = await runTaskControlArgs(["status", requestId], {
      paths: maestro.paths, out: (line) => out.push(line), err: (line) => out.push(line), timeoutMs: 4_000,
      // Each poll is one exchange round on both nodes, after yielding to the sockets.
      wait: async (ms) => { await new Promise((resolve) => setTimeout(resolve, ms)); await maestro.control(); await target.control(); },
    });
    const result = JSON.parse(out.at(-1)!);
    expect(result).toMatchObject({ state: "succeeded", taskId, taskState: "failed", processState: "closed",
      reportedState: "failed", reportedReason: "cwd must be an absolute path" });
    expect(code).toBe(0);

    // task show (node:util parseArgs is not available here) names what "dispatched" means and the last answer.
    expect(resolveTaskDetail(maestro.paths, taskId)).toMatchObject({ ok: true, detail: { dispatchState: "dispatched",
      dispatchMeaning: expect.stringContaining("not acknowledged"),
      lastStatus: { taskState: "failed", reportedState: "failed", reportedReason: "cwd must be an absolute path" } } });
    await Promise.all([maestro.idle(), target.idle()]);
    await maestro.close();
    await target.close();
  });
});

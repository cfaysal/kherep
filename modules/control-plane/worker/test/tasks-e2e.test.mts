import { runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// End to end in workerd (issue #31, item 5): the operator API or a session's
// task request dispatches session.start through the real NodeSession to the
// real node client and session runner, whose fake claude "starts" the session;
// task.report started and done travel back into the Registry.
import { readRequest, readTask, writeRequest } from "../../node/task-records.mts";
import { runTaskArgs } from "../../node/task-cli.mts";
import { registry } from "./helpers.mts";
import { api, installAccess, SESSION_ID, startTaskNode, WAIT } from "./task-helpers.mts";

beforeAll(installAccess);
afterAll(() => { vi.restoreAllMocks(); });

const uniqueOs = () => `os-${crypto.randomUUID().slice(0, 8)}`;
const taskOf = async (taskId: string) => (await registry().getTask(taskId))!;
const auditFor = (taskId: string) => runInDurableObject(registry(), (_i, state) =>
  state.storage.sql.exec("SELECT actor, action, detail FROM audit WHERE detail LIKE ? ORDER BY id", `%${taskId}%`).toArray());

describe("operator task end to end", () => {
  it("POST /api/tasks -> node start -> task.report started -> task done -> done", async () => {
    const os = uniqueOs();
    const node = await startTaskNode(`e2e-${os}`, { os, sessions: { enabled: true } });
    const response = await api("/api/tasks", { title: "Fix the build", text: "make the build green", requirements: { os } });
    expect(response.status).toBe(201);
    const { taskId, nodeId } = (await response.json()) as { taskId: string; nodeId: string };
    expect(nodeId).toBe(node.nodeId);

    await vi.waitFor(() => expect(readTask(node.paths, taskId)?.state).toBe("started"), WAIT);
    const start = node.calls.find((args) => args[0] === "--bg")!;
    expect(start.slice(0, 5)).toEqual(["--bg", "--name", `task-${taskId.slice(0, 8)}`, "--permission-mode", "auto"]);
    expect(start[5]).toContain(`Task ${taskId} from the operator via the Kherep Control Plane: make the build green`);
    await node.exchange();
    await vi.waitFor(async () => expect(await taskOf(taskId)).toMatchObject({ state: "started", sessionId: SESSION_ID }), WAIT);

    // The session reports it finished through the CLI; the daemon sends it.
    expect(runTaskArgs({ positionals: ["done", taskId], values: { summary: "build is green" } },
      { paths: node.paths, env: { CLAUDE_CODE_SESSION_ID: SESSION_ID }, out: () => {}, err: () => {} })).toBe(0);
    await node.exchange();
    await vi.waitFor(async () => expect(await taskOf(taskId)).toMatchObject({ state: "done", resultSummary: "build is green" }), WAIT);

    // Continue resumes the same session in the background.
    expect((await api(`/api/tasks/${taskId}/continue`, { prompt: "also update the changelog" })).status).toBe(202);
    await vi.waitFor(() => expect(node.calls.some((args) => args[0] === "--resume" && args[1] === SESSION_ID)).toBe(true), WAIT);
    const audit = await auditFor(taskId);
    expect(audit.map((row) => row.action)).toEqual(expect.arrayContaining(["task.create", "task.report", "task.continue"]));
    for (const row of audit) {
      expect(String(row.detail)).not.toContain("make the build green");
      expect(String(row.detail)).not.toContain("changelog");
    }
    await node.close();
  });
});

describe("delegated task requests", () => {
  it("are refused by default on both sides and dispatched when both opt in", async () => {
    const os = uniqueOs();
    const request = (requestedBy: string, directive = "Ask a worker node to run the suite") => ({
      requestId: crypto.randomUUID(), title: "Run the suite", text: "run npm test", requirements: { os }, directive, requestedBy,
      createdAt: new Date().toISOString(), state: "pending" as const,
    });
    // A requesting node without delegate.request: the Worker refuses a request it sends anyway.
    const plain = await startTaskNode(`plain-${os}`, {});
    const refused = request("maestro");
    writeRequest(plain.paths, refused);
    plain.raw(plain.client.requestTask(refused));
    await vi.waitFor(() => expect(readRequest(plain.paths, refused.requestId)?.reason).toMatch(/sessions\.delegate\.request/), WAIT);
    await plain.close();

    const target = await startTaskNode(`target-${os}`, { os, sessions: { enabled: true } });
    const maestro = await startTaskNode(`maestro-${os}`, { sessions: { delegate: { request: true } } });
    // The target does not accept delegated tasks yet: no node fits.
    const first = request("maestro");
    writeRequest(maestro.paths, first);
    await maestro.exchange();
    await vi.waitFor(() => expect(readRequest(maestro.paths, first.requestId)?.state).toBe("refused"), WAIT);
    expect(readRequest(maestro.paths, first.requestId)?.reason).toMatch(/sessions\.delegate\.accept\.v1/);
    await target.close();

    const accepting = await startTaskNode(`accepting-${os}`, { os, sessions: { enabled: true, delegate: { accept: true, request: true } } });
    const empty = request("maestro", " ");
    const ok = request("maestro");
    writeRequest(maestro.paths, empty);
    writeRequest(maestro.paths, ok);
    await maestro.exchange();
    await vi.waitFor(() => {
      expect(readRequest(maestro.paths, empty.requestId)).toMatchObject({ state: "refused", reason: expect.stringMatching(/directive is empty/) });
      expect(readRequest(maestro.paths, ok.requestId)).toMatchObject({ state: "dispatched", nodeId: accepting.nodeId });
    }, WAIT);
    const taskId = readRequest(maestro.paths, ok.requestId)!.taskId!;
    await vi.waitFor(() => expect(readTask(accepting.paths, taskId)?.state).toBe("started"), WAIT);
    const prompt = accepting.calls.find((args) => args[0] === "--bg")!;
    expect(prompt.slice(3, 5)).toEqual(["--permission-mode", "auto"]);
    expect(prompt[5]).toContain(`requested by session ${maestro.nodeId}/maestro on the operator's directive`);
    expect(prompt[5]).toContain(`"Ask a worker node to run the suite"`);
    await accepting.exchange();
    await vi.waitFor(async () => expect(await taskOf(taskId)).toMatchObject({ state: "started", createdBy: `session:${maestro.nodeId}/maestro` }), WAIT);

    // No chains: the task's own session may not request another task. Its node
    // refuses locally; the Worker refuses a request sent past that check.
    const chained = request(`task-${taskId.slice(0, 8)}`);
    writeRequest(accepting.paths, chained);
    accepting.raw(accepting.client.requestTask(chained));
    await vi.waitFor(() => expect(readRequest(accepting.paths, chained.requestId)?.reason).toBe("a session started for a task cannot request tasks"), WAIT);
    const audit = await auditFor(taskId);
    expect(audit).toEqual(expect.arrayContaining([expect.objectContaining({ action: "task.create", actor: `session:${maestro.nodeId}/maestro` })]));
    const created = JSON.parse(String(audit.find((row) => row.action === "task.create")!.detail));
    expect(created).toMatchObject({ requestedBy: `${maestro.nodeId}/maestro`, directive: "Ask a worker node to run the suite" });
    for (const row of audit) expect(String(row.detail)).not.toContain("run npm test");
    await Promise.all([maestro.idle(), accepting.idle()]);
    await maestro.close();
    await accepting.close();
  });
});

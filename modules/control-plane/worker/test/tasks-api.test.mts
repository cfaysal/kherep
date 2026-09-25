import { runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { makeEnvelope } from "../../protocol.mts";
import { authenticate, enroll, FACTS, newKey, registry, session } from "./helpers.mts";
import { api, installAccess } from "./task-helpers.mts";

// Operator task API (issue #31, item 5): validation, node selection, the
// operator-only rule and the audit trail without task text.

beforeAll(installAccess);
afterAll(() => { vi.restoreAllMocks(); });

const SECRET = "task text that must never reach the audit";
const uniqueOs = () => `os-${crypto.randomUUID().slice(0, 8)}`;

// A registered, online node without a socket: session.start just waits in its outbox.
async function onlineNode(name: string, os: string, capabilities: string[], runtimes = ["claude"]): Promise<string> {
  const nodeId = await enroll(await newKey(), name);
  await registry().updateRegistration(nodeId, { ...FACTS, os }, runtimes.map((r) => ({ name: r, kind: "cli" as const })), capabilities);
  await registry().setStatus(nodeId, "online", Date.now());
  return nodeId;
}

const create = (requirements: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  api("/api/tasks", { title: "Fix the build", text: SECRET, requirements, ...extra });

describe("POST /api/tasks", () => {
  it("validates the body and refuses codex and bypassPermissions", async () => {
    expect((await api("/api/tasks", { title: "t" })).status).toBe(400);
    expect((await api("/api/tasks", { title: "a\nb", text: "x" })).status).toBe(400);
    expect((await create({ shell: "bash" })).status).toBe(400);
    const codex = await create({ runtime: "codex" });
    expect([codex.status, await codex.json()]).toEqual([400, { error: "runtime codex is not supported yet; this step starts Claude sessions only" }]);
    expect((await create({}, { permissionMode: "bypassPermissions" })).status).toBe(400);
    expect((await create({}, { permissionMode: "plan" })).status).toBe(400);
  });

  it("picks an online node by runtime, os and capabilities, then by load; 409 when none fits", async () => {
    const os = uniqueOs();
    const none = await create({ os });
    expect(none.status).toBe(409);
    expect(((await none.json()) as { error: string }).error).toMatch(/^no online node with sessions\.v1 .* on os-/);
    await onlineNode("sel-nosessions", os, ["session.list"]);
    await onlineNode("sel-nocli", os, ["sessions.v1"], []);
    await onlineNode("sel-gpu", os, ["sessions.v1", "gpu"], ["codex"]);
    expect((await create({ os })).status).toBe(409);
    const a = await onlineNode("sel-a", os, ["sessions.v1", "gpu"]);
    const b = await onlineNode("sel-b", os, ["sessions.v1", "gpu"]);
    const offline = await onlineNode("sel-c", os, ["sessions.v1", "gpu"]);
    await registry().setStatus(offline, "offline", Date.now());
    const picked: string[] = [];
    for (let i = 0; i < 4; i++) {
      const response = await create({ os, capabilities: ["gpu"] });
      expect(response.status).toBe(201);
      picked.push(((await response.json()) as { nodeId: string }).nodeId);
    }
    expect(picked).toEqual([a, b, a, b]);
    // The command waits in the node's outbox with its validated args.
    const pending = await runInDurableObject(session(a), (_i, state) =>
      state.storage.sql.exec("SELECT command, args FROM outbox ORDER BY seq").toArray());
    expect(pending.map((p) => p.command)).toEqual(["session.start", "session.start"]);
    expect(JSON.parse(String(pending[0].args))).toMatchObject({ runtime: "claude", permissionMode: "auto", prompt: SECRET });
  });

  it("audits every task action without the task text", async () => {
    const os = uniqueOs();
    const nodeId = await onlineNode("audit-node", os, ["sessions.v1"]);
    const created = (await (await create({ os }, { permissionMode: "acceptEdits" })).json()) as { taskId: string };
    expect((await api(`/api/tasks/${created.taskId}`).then((r) => r.json()) as { task: { text: string } }).task.text).toBe(SECRET);
    const list = await (await api("/api/tasks")).text();
    expect(list).toContain(created.taskId);
    expect(list).not.toContain(SECRET);
    await create({ os: uniqueOs() });
    const audit = await runInDurableObject(registry(), (_i, state) =>
      state.storage.sql.exec("SELECT actor, action, target, detail FROM audit WHERE action LIKE 'task.%'").toArray());
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ actor: "operator@example.com", action: "task.create", target: nodeId }),
      expect.objectContaining({ actor: "operator@example.com", action: "task.refuse" }),
    ]));
    for (const row of audit) expect(String(row.detail)).not.toContain(SECRET);
  });
});

describe("operator-only session control", () => {
  it("offers no node path and no command API path to start, stop or continue a session", async () => {
    for (const command of ["session.start", "session.stop", "session.continue"]) {
      const nodeId = await onlineNode(`cmd-${command}`, uniqueOs(), ["sessions.v1"]);
      const response = await api(`/api/nodes/${nodeId}/commands`, { command });
      expect(response.status).toBe(400);
    }
    // A node that sends a command frame gets an error; nothing is queued.
    const key = await newKey();
    const nodeId = await enroll(key, "sender");
    const socket = await authenticate(nodeId, key);
    socket.send(makeEnvelope("command", { commandId: "c1", command: "session.start", args: {} }, 1, 0));
    expect(((await socket.next()).body as { error: string }).error).toBe("unexpected command");
    expect(await registry().listTasks(200)).not.toEqual(expect.arrayContaining([expect.objectContaining({ nodeId })]));
    // The Durable Object refuses args that do not validate, even from inside the Worker.
    expect(await session(nodeId).enqueue("session.start", { taskId: "x" })).toEqual({ ok: false, error: "invalid command arguments" });
    socket.ws.close(1000, "done");
  });

  it("stops and continues only a known task in a fitting state", async () => {
    const os = uniqueOs();
    const nodeId = await onlineNode("ctl-node", os, ["sessions.v1"]);
    const { taskId } = (await (await create({ os })).json()) as { taskId: string };
    expect((await api(`/api/tasks/${crypto.randomUUID()}/stop`, {})).status).toBe(404);
    expect((await api(`/api/tasks/${taskId}/continue`, { prompt: "more" })).status).toBe(409);
    expect((await api(`/api/tasks/${taskId}/stop`, {})).status).toBe(202);
    await registry().reportTask(nodeId, { taskId, state: "done" });
    expect((await api(`/api/tasks/${taskId}/stop`, {})).status).toBe(409);
    expect((await api(`/api/tasks/${taskId}/continue`, {})).status).toBe(400);
    expect((await api(`/api/tasks/${taskId}/continue`, { prompt: "more" })).status).toBe(202);
    // Only the task's node may report on it.
    const other = await onlineNode("ctl-other", uniqueOs(), ["messaging.v1"]);
    expect(await registry().reportTask(other, { taskId, state: "failed" })).toBe(false);
    // A message carries a task id only between the task's node and another one.
    const message = (to: string, id: string) => registry().sendMessage({ messageId: crypto.randomUUID(), from: { nodeId: other, session: "peer" },
      to: { nodeId: to, session: "s" }, text: "hi", taskId: id }, "test");
    expect(await message(other, crypto.randomUUID())).toEqual({ ok: false, error: "unknown task for this message" });
    await registry().updateRegistration(nodeId, { ...FACTS, os }, [{ name: "claude", kind: "cli" }], ["sessions.v1", "messaging.v1"]);
    const sent = await message(nodeId, taskId);
    expect(sent.ok && sent.effects.deliveries[0].body.taskId).toBe(taskId);
  });
});

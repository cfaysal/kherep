import fs from "node:fs";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Intercom sessions end to end in workerd (issue #74): `msg send <node> --new`
// on a requesting node becomes a labelled task request for exactly that node;
// the Worker dispatches it there, not to another accepting node, and the
// target starts the session under its task-<8> name with the label recorded.
import { writeConfig } from "../../node/config.mts";
import { writeDirectory } from "../../node/exchange.mts";
import { runMsgArgs } from "../../node/msg-cli.mts";
import { readTask } from "../../node/task-records.mts";
import { registry } from "./helpers.mts";
import { installAccess, startTaskNode, WAIT } from "./task-helpers.mts";

beforeAll(installAccess);
afterAll(() => { vi.restoreAllMocks(); });

const suffix = () => crypto.randomUUID().slice(0, 8);

// The requesting node's CLI reads its config and policy from disk.
function writeNodeFiles(node: Awaited<ReturnType<typeof startTaskNode>>, name: string): void {
  fs.mkdirSync(node.paths.dir, { recursive: true });
  writeConfig(node.paths.config, { version: 1, controlUrl: "https://control.example.invalid", nodeId: node.nodeId, name, publicKey: "",
    privateKeyFile: "", policyFile: node.paths.policy, enrolledAt: new Date().toISOString() });
  fs.writeFileSync(node.paths.policy, JSON.stringify({ version: 1, allowedCommands: [],
    sessions: { workspaceRoots: [node.workspace], delegate: { request: true } } }));
}

async function msgNew(node: Awaited<ReturnType<typeof startTaskNode>>, target: string, text: string) {
  writeDirectory(node.paths, await registry().directory());
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMsgArgs({ positionals: ["send", target, text], values: { new: "claude", directive: "Open a new intercom session on that node", wait: "5" } }, {
    paths: node.paths, env: { CLAUDE_CODE_SESSION_ID: "maestro" }, out: (l) => out.push(l), err: (l) => err.push(l),
    // Each wait step is one exchange round of the requesting daemon.
    sleep: async () => { await node.exchange(); await new Promise((resolve) => setTimeout(resolve, 20)); },
  });
  return { code, out, err };
}

describe("intercom sessions", () => {
  it("msg send --new starts a labelled session on exactly the named node, or prints the refusal", async () => {
    const id = suffix();
    const accepting = { sessions: { enabled: true, delegate: { accept: true } } };
    // Created first and idle, so load-based selection would pick it.
    const other = await startTaskNode(`other-${id}`, accepting);
    const target = await startTaskNode(`target-${id}`, accepting);
    const plain = await startTaskNode(`plain-${id}`, { sessions: { enabled: true } });
    const maestro = await startTaskNode(`maestro-${id}`, { sessions: { delegate: { request: true } } });
    writeNodeFiles(maestro, `maestro-${id}`);

    const sent = await msgNew(maestro, `target-${id}`, "please review PR 12");
    expect(sent).toMatchObject({ code: 0, err: [] });
    const [taskId] = sent.out;
    await vi.waitFor(() => expect(readTask(target.paths, taskId)?.state).toBe("started"), WAIT);
    const label = `intercom: claude@maestro-${id}`;
    expect(readTask(target.paths, taskId)?.label).toBe(label);
    const start = target.calls.find((args) => args[0] === "--bg")!;
    expect(start.slice(0, 3)).toEqual(["--bg", "--name", `task-${taskId.slice(0, 8)}`]);
    expect(start[5]).toContain(`This is an intercom session (${label}) for a conversation with session ${maestro.nodeId}/maestro`);
    expect(start[5]).toContain("Task: please review PR 12");
    expect(start[5]).toContain('The operator\'s directive, quoted: "Open a new intercom session on that node"');
    expect(other.calls).toEqual([]);
    expect(await registry().getTask(taskId)).toMatchObject({ nodeId: target.nodeId, label, requirements: { node: target.nodeId } });

    // A node that does not accept delegated tasks: refused with the reason, no fallback to the accepting one.
    const refused = await msgNew(maestro, `plain-${id}`, "hello");
    expect(refused.code).toBe(1);
    expect(refused.err[0]).toMatch(new RegExp(`refused: node plain-${id} \\(${plain.nodeId}\\) cannot take the task: `
      + "it does not advertise sessions\\.delegate\\.accept\\.v1"));
    expect(other.calls).toEqual([]);
    await Promise.all([maestro.idle(), target.idle(), other.idle(), plain.idle()]);
    for (const node of [maestro, target, other, plain]) await node.close();
  });
});

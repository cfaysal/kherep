import { describe, expect, it } from "vitest";

// The real node-side protocol client (modules/control-plane/node), driven over
// a real WebSocket against the real NodeSession. Its node:crypto signing runs
// here through the test-only nodejs_compat flag (vitest.config.mts); the
// deployed Worker bundle does not use it.
import { NodeClient } from "../../node/client.mts";
import { generateIdentity } from "../../node/identity.mts";
import { DEFAULT_POLICY } from "../../node/policy.mts";
import { enroll, FACTS, registry, session, workerFetch } from "./helpers.mts";

function settle(ms = 100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("node client against the Worker", () => {
  it("authenticates, registers and answers a dispatched command", async () => {
    const identity = generateIdentity();
    const nodeId = await enroll({ publicKey: identity.publicKey, privateKey: undefined as unknown as CryptoKey });
    const client = new NodeClient({
      nodeId, identity, policy: DEFAULT_POLICY,
      handlers: {
        "node.status": async () => ({ nodeId }),
        "runtime.list": async () => [{ name: "ollama", kind: "local-endpoint", endpoint: "http://127.0.0.1:11434" }],
        "session.list": async () => [{ sessionId: "s1", runtime: "claude", state: "running" }],
      },
      facts: () => FACTS, runtimes: async () => [{ name: "codex", kind: "cli" }], sessions: async () => [],
    });

    const response = await workerFetch(`/node/connect?nodeId=${nodeId}`, { headers: { upgrade: "websocket" } });
    const ws = response.webSocket!;
    let chain = Promise.resolve();
    ws.addEventListener("message", (event) => {
      chain = chain.then(async () => { for (const frame of await client.onFrame(event.data as string)) ws.send(frame); });
    });
    ws.accept();
    await settle();
    expect(client.authenticated).toBe(true);
    expect((await registry().getNode(nodeId))).toMatchObject({ status: "online", runtimes: [{ name: "codex", kind: "cli" }] });

    await session(nodeId).enqueue("session.list");
    await session(nodeId).enqueue("runtime.list");
    await settle();
    // RPC typing maps the `unknown` result field to never; the value is plain JSON.
    const commands = await session(nodeId).recentCommands(5) as unknown as { state: string }[];
    expect(commands.map((c) => c.state)).toEqual(["done", "done"]);
    expect(await registry().listSessions()).toEqual(
      expect.arrayContaining([expect.objectContaining({ nodeId, sessionId: "s1", runtime: "claude" })]));
    expect((await registry().getNode(nodeId))?.runtimes).toEqual(
      [{ name: "ollama", kind: "local-endpoint", endpoint: "http://127.0.0.1:11434" }]);
    expect((await session(nodeId).status()).pending).toBe(0);
    ws.close(1000, "done");
  });
});

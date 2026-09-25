import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

// The real node-side protocol client (modules/control-plane/node), driven over
// a real WebSocket against the real NodeSession. Its node:crypto signing runs
// here through the test-only nodejs_compat flag (vitest.config.mts); the
// deployed Worker bundle does not use it.
import type { SessionInfo } from "../../protocol.mts";
import { MESSAGING_CAPABILITY, type MessageDeliverBody } from "../../protocol-messages.mts";
import { NodeClient, type ClientOptions } from "../../node/client.mts";
import { generateIdentity } from "../../node/identity.mts";
import { DEFAULT_POLICY } from "../../node/policy.mts";
import { routeEffects } from "../src/message-routing.mts";
import { enroll, FACTS, registry, session, workerFetch } from "./helpers.mts";

function settle(ms = 100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectClient(options: Partial<ClientOptions> = {}) {
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
    storeMessage: () => { throw new Error("not enabled"); },
    ...options,
  });
  const response = await workerFetch(`/node/connect?nodeId=${nodeId}`, { headers: { upgrade: "websocket" } });
  const ws = response.webSocket!;
  let chain = Promise.resolve();
  const send = (frames: Promise<string[]>) => { chain = chain.then(async () => { for (const frame of await frames) ws.send(frame); }); };
  ws.addEventListener("message", (event) => send(client.onFrame(event.data as string)));
  ws.accept();
  // Wait for the register frame to reach the Registry rather than for a fixed
  // time: on a slow runner the test can otherwise read the node after auth
  // (status online) but before register (capabilities, runtimes).
  await vi.waitFor(async () => {
    expect(client.authenticated).toBe(true);
    expect((await registry().getNode(nodeId))?.capabilities.length).toBeGreaterThan(0);
  }, { timeout: 5_000, interval: 50 });
  // Mirrors the daemon's periodic snapshot on the same ordered chain.
  return { nodeId, client, ws, snapshot: () => send(client.sessionsSnapshot()) };
}

describe("node client against the Worker", () => {
  it("authenticates, registers and answers a dispatched command", async () => {
    const { nodeId, ws } = await connectClient();
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

  it("keeps the last known sessions when the node's listing fails", async () => {
    const known: SessionInfo = { sessionId: "c1", runtime: "claude-code", state: "running", name: "review", cwd: "/work/repo", kind: "interactive" };
    let fail = false;
    const sessions = async () => { if (fail) throw new Error("claude agents failed: timed out"); return [known]; };
    const { nodeId, ws, snapshot } = await connectClient({
      sessions, handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": sessions },
    });
    const mine = async () => (await registry().listSessions()).filter((s) => s.nodeId === nodeId);
    expect(await mine()).toEqual([expect.objectContaining({ ...known, nodeId })]);

    fail = true;
    snapshot();
    await session(nodeId).enqueue("session.list");
    await settle();
    const [result] = await session(nodeId).recentCommands(1) as unknown as { state: string; error: string }[];
    expect(result).toMatchObject({ state: "failed", error: "claude agents failed: timed out" });
    expect(await mine()).toEqual([expect.objectContaining({ ...known, nodeId })]);
    ws.close(1000, "done");
  });

  it("delivers an operator message to a node whose policy accepts it", async () => {
    const stored: MessageDeliverBody[] = [];
    const { nodeId, ws } = await connectClient({
      policy: { ...DEFAULT_POLICY, messaging: { accept: [{ session: "review", from: ["operator"] }] } },
      storeMessage: (body) => { stored.push(body); },
    });
    expect((await registry().getNode(nodeId))?.capabilities).toContain(MESSAGING_CAPABILITY);

    const messageId = crypto.randomUUID();
    const sent = await registry().sendMessage({ messageId, from: { nodeId: "operator", session: "operator@example.com" },
      to: { nodeId, session: "review" }, text: "please review" }, "operator@example.com");
    if (!sent.ok) throw new Error(sent.error);
    await routeEffects(env, sent.effects);
    await settle();

    expect(stored).toEqual([expect.objectContaining({ messageId, toSession: "review", text: "please review" })]);
    const row = await runInDurableObject(registry(), (_i, state) =>
      state.storage.sql.exec("SELECT state, text FROM messages WHERE id = ?", messageId).one());
    expect(row).toEqual({ state: "accepted", text: null });
    ws.close(1000, "done");
  });
});

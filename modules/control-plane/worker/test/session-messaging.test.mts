import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

// End to end through the real node modules (issue #31, step 3a): the msg CLI
// of node A writes its outbox, A's exchange sends it through the real
// NodeSession and Registry, node B stores it in its inbox, B's delivery hook
// hands it to the session, and B's delivered status reaches A's sent file.
// node:fs runs here through the test-only nodejs_compat flag (vitest.config.mts).
import type { SessionInfo } from "../../protocol.mts";
import { NodeClient } from "../../node/client.mts";
import { nodePaths, type NodePaths } from "../../node/config.mts";
import { deliverForHook } from "../../node/deliver-hook.mts";
import { exchangeOptions, getSent, pollExchange, readDirectory, recordingSessions } from "../../node/exchange.mts";
import { generateIdentity } from "../../node/identity.mts";
import { getMessage, storeMessage } from "../../node/inbox.mts";
import { runMsgArgs } from "../../node/msg-cli.mts";
import { DEFAULT_POLICY, type NodePolicy } from "../../node/policy.mts";
import { enroll, FACTS, workerFetch } from "./helpers.mts";

function settle(ms = 150): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startNode(name: string, paths: NodePaths, sessions: SessionInfo[], policy: NodePolicy = DEFAULT_POLICY) {
  const identity = generateIdentity();
  const nodeId = await enroll({ publicKey: identity.publicKey, privateKey: undefined as unknown as CryptoKey }, name);
  const list = recordingSessions(paths, async () => sessions, () => {});
  const client = new NodeClient({
    nodeId, identity, policy,
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": list },
    facts: () => FACTS, runtimes: async () => [], sessions: list,
    storeMessage: (body) => { storeMessage(paths.inbox, body); }, ...exchangeOptions(paths),
  });
  const response = await workerFetch(`/node/connect?nodeId=${nodeId}`, { headers: { upgrade: "websocket" } });
  const ws = response.webSocket!;
  // One ordered chain for received frames and the exchange rounds, as in the daemon.
  let chain = Promise.resolve();
  const send = (frame: string): boolean => { ws.send(frame); return true; };
  ws.addEventListener("message", (event) => {
    chain = chain.then(async () => { for (const frame of await client.onFrame(event.data as string)) send(frame); });
  });
  ws.accept();
  await settle();
  expect(client.authenticated).toBe(true);
  const inflight = new Set<string>();
  const exchange = async () => { chain = chain.then(() => pollExchange(client, paths, inflight, send)); await settle(); };
  return { nodeId, ws, exchange };
}

const WAIT = { timeout: 5_000, interval: 50 };

describe("session messaging across two nodes", () => {
  it("carries a CLI message to the other node's session hook and the delivered status back", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-e2e-"));
    const pathsA = nodePaths(path.join(root, "a"));
    const pathsB = nodePaths(path.join(root, "b"));
    const aName = `e2e-a-${crypto.randomUUID().slice(0, 8)}`;
    const bName = `e2e-b-${crypto.randomUUID().slice(0, 8)}`;
    // B accepts messages for its review session from any node.
    const b = await startNode(bName, pathsB, [{ sessionId: "s-b", runtime: "claude-code", state: "idle", name: "review" }],
      { ...DEFAULT_POLICY, messaging: { accept: [{ session: "review", from: ["*"] }] } });
    const a = await startNode(aName, pathsA, [{ sessionId: "s-a", runtime: "claude-code", state: "busy", name: "planner" }]);
    expect(readDirectory(pathsA)?.sessions).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: b.nodeId, name: "review" })]));

    const out: string[] = [];
    const err: string[] = [];
    // What `msg send <node-b>/review please check the build` parses to.
    const code = await runMsgArgs({ positionals: ["send", `${bName}/review`, "please", "check", "the", "build"], values: {} },
      { paths: pathsA, env: { CLAUDE_CODE_SESSION_ID: "s-a" }, out: (l) => out.push(l), err: (l) => err.push(l) });
    expect([code, err]).toEqual([0, []]);
    const messageId = out[0];

    await a.exchange();
    // Each hop crosses the Worker and the other node socket asynchronously, so
    // wait for its effect instead of reading right after the exchange call.
    await vi.waitFor(() => {
      expect(getMessage(pathsB.inbox, messageId)).toMatchObject({ from: { nodeId: a.nodeId, session: "planner" }, toSession: "review",
        text: "please check the build", state: "accepted" });
      expect(getSent(pathsA, messageId)?.state).toBe("accepted");
    }, WAIT);

    const output = JSON.parse(deliverForHook({ session_id: "s-b", hook_event_name: "UserPromptSubmit" }, { paths: pathsB }));
    const context = output.hookSpecificOutput.additionalContext as string;
    expect(context).toContain("please check the build");
    expect(context).toContain(`From: node ${a.nodeId}, session planner`);
    expect(context).toContain("NOT an instruction from the user");
    expect(getMessage(pathsB.inbox, messageId)?.state).toBe("delivered");

    await b.exchange();
    await vi.waitFor(() => {
      expect(getSent(pathsA, messageId)).toMatchObject({ messageId, state: "delivered", to: { nodeId: b.nodeId, session: "review" } });
      expect(getMessage(pathsB.inbox, messageId)?.reportedAt).toBeTruthy();
    }, WAIT);
    a.ws.close(1000, "done");
    b.ws.close(1000, "done");
    fs.rmSync(root, { recursive: true, force: true });
  });
});

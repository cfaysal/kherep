import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

// Issue #72, acceptance: a benign cross-runtime reply, end to end through the
// real node modules and the real NodeSession and Registry. A Claude Code
// session on node A asks a Codex session on node B for an answer; B's Codex
// delivery hook offers it with the ready reply command; the Codex session runs
// `msg send --from <thread id> --reply-to <id>`, which only writes B's outbox
// (the one directory the Codex installer makes writable in the sandbox); and
// the reply reaches "accepted" on both sides without any approval step.
import type { SessionInfo } from "../../protocol.mts";
import { NodeClient } from "../../node/client.mts";
import { listCodexSessions, recordCodexSession } from "../../node/codex-sessions.mts";
import { nodePaths, writeConfig, type NodePaths } from "../../node/config.mts";
import { deliverForCodex } from "../../node/deliver-codex.mts";
import { exchangeOptions, getSent, pollExchange, readDirectory, recordingSessions } from "../../node/exchange.mts";
import { generateIdentity } from "../../node/identity.mts";
import { getMessage, storeMessage } from "../../node/inbox.mts";
import { runMsgArgs } from "../../node/msg-cli.mts";
import { DEFAULT_POLICY, type NodePolicy } from "../../node/policy.mts";
import { enroll, FACTS, workerFetch } from "./helpers.mts";

const WAIT = { timeout: 5_000, interval: 50 };
const THREAD = "019a2b3c-4d5e-7f60-8123-456789abcdef";

const settle = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function startNode(name: string, paths: NodePaths, list: () => Promise<SessionInfo[]>, policy: NodePolicy) {
  const identity = generateIdentity();
  const nodeId = await enroll({ publicKey: identity.publicKey, privateKey: undefined as unknown as CryptoKey }, name);
  // The session tools need node.json; the key stays in memory in this test.
  fs.mkdirSync(paths.dir, { recursive: true });
  writeConfig(paths.config, { version: 1, controlUrl: "https://control.example.invalid", nodeId, name, publicKey: identity.publicKey,
    privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: new Date().toISOString() });
  fs.mkdirSync(paths.outbox, { recursive: true }); // as onboard and the daemon do
  const sessions = recordingSessions(paths, list, () => {});
  const client = new NodeClient({
    nodeId, identity, policy,
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": sessions },
    facts: () => FACTS, runtimes: async () => [], sessions,
    storeMessage: (body) => { storeMessage(paths.inbox, body); }, ...exchangeOptions(paths),
  });
  const response = await workerFetch(`/node/connect?nodeId=${nodeId}`, { headers: { upgrade: "websocket" } });
  const ws = response.webSocket!;
  let chain = Promise.resolve();
  const send = (frame: string): boolean => { ws.send(frame); return true; };
  ws.addEventListener("message", (event) => {
    chain = chain.then(async () => { for (const frame of await client.onFrame(event.data as string)) send(frame); });
  });
  ws.accept();
  await vi.waitFor(() => expect(client.authenticated).toBe(true), WAIT);
  const inflight = new Set<string>();
  const exchange = async () => { chain = chain.then(() => pollExchange(client, paths, inflight, send)); await settle(); };
  return { nodeId, ws, exchange, idle: () => chain };
}

describe("cross-runtime reply", () => {
  it("a Codex session answers a Claude Code session with msg send --reply-to and the reply is accepted", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-e2e-reply-"));
    const pathsA = nodePaths(path.join(root, "a"));
    const pathsB = nodePaths(path.join(root, "b"));
    const aName = `claude-${crypto.randomUUID().slice(0, 8)}`;
    const bName = `codex-node-${crypto.randomUUID().slice(0, 8)}`;
    const accept = (session: string): NodePolicy => ({ ...DEFAULT_POLICY, messaging: { accept: [{ session, from: ["*"] }] } });
    // B's session list is the Codex sessions its delivery hook recorded, as in
    // the daemon; the session started before B connected.
    recordCodexSession(pathsB, THREAD, root);
    const b = await startNode(bName, pathsB, async () => listCodexSessions(pathsB), accept(THREAD));
    const a = await startNode(aName, pathsA,
      async () => [{ sessionId: "s-a", runtime: "claude-code", state: "busy", name: "planner" }], accept("planner"));
    const codexHook = (event: string) => deliverForCodex({ session_id: THREAD, cwd: root, hook_event_name: event },
      { paths: pathsB, replyCommand: "kherep-node" });
    expect(codexHook("SessionStart")).toContain(`msg send --from ${THREAD}`);
    await vi.waitFor(() => expect(readDirectory(pathsA)?.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: b.nodeId, sessionId: THREAD, runtime: "codex" })])), WAIT);

    // A (Claude Code) asks B's Codex session for a benign answer.
    const out: string[] = [];
    const asked = await runMsgArgs({ positionals: ["send", `${bName}/${THREAD}`, "which", "branch", "are", "you", "on?"], values: {} },
      { paths: pathsA, env: { CLAUDE_CODE_SESSION_ID: "s-a" }, out: (l) => out.push(l), err: () => {} });
    expect(asked).toBe(0);
    const question = out[0];
    await a.exchange();
    await vi.waitFor(() => {
      expect(getMessage(pathsB.inbox, question)).toMatchObject({ toSession: THREAD, state: "accepted" });
      expect(getSent(pathsA, question)?.state).toBe("accepted");
    }, WAIT);

    // B's Codex hook offers it with the ready reply command, then Stop confirms it.
    const context = JSON.parse(codexHook("UserPromptSubmit")).hookSpecificOutput.additionalContext as string;
    expect(context).toContain("which branch are you on?");
    expect(context).toContain(`kherep-node msg send --from ${THREAD} --reply-to ${question} -- <reply text>`);
    codexHook("Stop");
    expect(getMessage(pathsB.inbox, question)?.state).toBe("delivered");

    // The Codex session runs that command (no CLAUDE_CODE_SESSION_ID in a Codex
    // session). It writes one outbox record and nothing else in the node directory.
    // Entry names and node.json only: the daemon side may rewrite its own files meanwhile.
    await b.idle();
    const snapshot = () => [fs.readdirSync(pathsB.dir).sort(), fs.statSync(pathsB.config).mtimeMs];
    const before = snapshot();
    const outboxBefore = fs.readdirSync(pathsB.outbox);
    const replyOut: string[] = [];
    const replyErr: string[] = [];
    const replied = await runMsgArgs({ positionals: ["send", "main"], values: { from: THREAD, "reply-to": question } },
      { paths: pathsB, env: {}, out: (l) => replyOut.push(l), err: (l) => replyErr.push(l) });
    expect([replied, replyErr]).toEqual([0, []]);
    const reply = replyOut[0];
    expect(snapshot()).toEqual(before);
    expect(fs.readdirSync(pathsB.outbox).filter((entry) => !outboxBefore.includes(entry))).toEqual([`${reply}.json`]);

    // B's daemon sends it; the Worker hands it to A, whose policy accepts it.
    await b.exchange();
    await vi.waitFor(() => expect(getSent(pathsB, reply))
      .toMatchObject({ state: "accepted", inReplyTo: question, to: { nodeId: a.nodeId, session: "planner" } }), WAIT);
    await vi.waitFor(() => expect(getMessage(pathsA.inbox, reply)).toMatchObject({
      from: { nodeId: b.nodeId, session: `codex-${THREAD.slice(-8)}` }, toSession: "planner", text: "main", inReplyTo: question, state: "accepted",
    }), WAIT);

    await Promise.all([a.idle(), b.idle()]);
    a.ws.close(1000, "done");
    b.ws.close(1000, "done");
    fs.rmSync(root, { recursive: true, force: true });
  });
});

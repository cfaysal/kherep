import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

// Issue #195, end to end through the real node modules and the real
// NodeSession and Registry: a lost answer on a live connection, a repeated
// send, and a daemon crash in the middle of an exchange on either side. Each
// case ends with exactly one delivery and the final state at the sender.
import { parseEnvelope } from "../../protocol.mts";
import type { SessionInfo } from "../../protocol.mts";
import { NodeClient } from "../../node/client.mts";
import { nodePaths, type NodePaths } from "../../node/config.mts";
import { exchangeOptions, getOutbox, getSent, pollExchange, recordingSessions, SEND_RETRY_MS, writeOutbox } from "../../node/exchange.mts";
import { generateIdentity, type NodeIdentity } from "../../node/identity.mts";
import { getMessage, markDelivered, messageIds, storeMessage } from "../../node/inbox.mts";
import { DEFAULT_POLICY, type NodePolicy } from "../../node/policy.mts";
import { enroll, FACTS, workerFetch } from "./helpers.mts";

const WAIT = { timeout: 5_000, interval: 50 };
const ACCEPTS: NodePolicy = { ...DEFAULT_POLICY, messaging: { accept: [{ session: "review", from: ["*"] }] } };
const SESSIONS: SessionInfo[] = [{ sessionId: "s-b", runtime: "claude-code", state: "idle", name: "review" }];

const settle = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Identity { nodeId: string; identity: NodeIdentity; paths: NodePaths; policy: NodePolicy }

async function enrolled(root: string, name: string, policy: NodePolicy = DEFAULT_POLICY): Promise<Identity> {
  const identity = generateIdentity();
  const nodeId = await enroll({ publicKey: identity.publicKey, privateKey: undefined as unknown as CryptoKey }, `${name}-${crypto.randomUUID().slice(0, 8)}`);
  return { nodeId, identity, paths: nodePaths(path.join(root, name)), policy };
}

// One daemon process: a fresh client and inflight map on the node's
// directory. drop decides which received frames are lost before handling,
// mute which outgoing frames never reach the socket.
async function start(node: Identity) {
  const list = recordingSessions(node.paths, async () => SESSIONS, () => {});
  const client = new NodeClient({
    nodeId: node.nodeId, identity: node.identity, policy: node.policy,
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": list },
    facts: () => FACTS, runtimes: async () => [], sessions: list,
    storeMessage: (body) => { storeMessage(node.paths.inbox, body); }, ...exchangeOptions(node.paths),
  });
  const response = await workerFetch(`/node/connect?nodeId=${node.nodeId}`, { headers: { upgrade: "websocket" } });
  const ws = response.webSocket!;
  const delivered: string[] = [];
  let drop = (_type: string, _body: Record<string, unknown>): boolean => false;
  let mute = (_type: string): boolean => false;
  let chain = Promise.resolve();
  const send = (frame: string): boolean => {
    const parsed = parseEnvelope(frame);
    if (!(parsed.ok && mute(parsed.envelope.type))) ws.send(frame);
    return true;
  };
  ws.addEventListener("message", (event) => {
    const parsed = parseEnvelope(event.data as string);
    const body = (parsed.ok ? parsed.envelope.body : {}) as Record<string, unknown>;
    if (parsed.ok && drop(parsed.envelope.type, body)) return;
    if (parsed.ok && parsed.envelope.type === "message.deliver") delivered.push(String(body.messageId));
    chain = chain.then(async () => { for (const frame of await client.onFrame(event.data as string)) send(frame); });
  });
  ws.accept();
  await vi.waitFor(() => expect(client.authenticated).toBe(true), WAIT);
  const inflight = new Map<string, number>();
  return {
    ws, client, delivered, inflight,
    exchange: async (now = Date.now()) => { chain = chain.then(() => pollExchange(client, node.paths, inflight, send, now)); await settle(); },
    idle: () => chain,
    dropIncoming: (rule: typeof drop) => { drop = rule; },
    muteOutgoing: (rule: typeof mute) => { mute = rule; },
    crash: async () => { drop = () => true; await chain; ws.close(1000, "crash"); },
  };
}

async function twoNodes() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-recovery-e2e-"));
  const a = await enrolled(root, "a");
  const b = await enrolled(root, "b", ACCEPTS);
  fs.mkdirSync(a.paths.outbox, { recursive: true });
  const messageId = crypto.randomUUID();
  writeOutbox(a.paths, { messageId, fromSession: "planner", to: { nodeId: b.nodeId, session: "review" }, text: "please check the build",
    createdAt: new Date().toISOString() });
  return { root, a, b, messageId };
}

describe("exchange recovery", () => {
  it("resends after a lost answer on the live connection; one delivery, and the sender sees the final state", async () => {
    const { root, a, b, messageId } = await twoNodes();
    const target = await start(b);
    const sender = await start(a);
    // Every status for the message is lost on the way to the sender: its answer and the forwarded accepted.
    sender.dropIncoming((type, body) => type === "message.status" && body.messageId === messageId);
    const t0 = Date.now();
    await sender.exchange(t0);
    await vi.waitFor(() => expect(getMessage(b.paths.inbox, messageId)?.state).toBe("accepted"), WAIT);
    await sender.idle();
    expect(getSent(a.paths, messageId)).toBeNull();
    expect(getOutbox(a.paths, messageId)).not.toBeNull();

    sender.dropIncoming(() => false);
    await sender.exchange(t0 + SEND_RETRY_MS - 1);
    await sender.idle();
    expect(getSent(a.paths, messageId)).toBeNull();
    await sender.exchange(t0 + SEND_RETRY_MS);
    await vi.waitFor(() => expect(getSent(a.paths, messageId)?.state).toBe("accepted"), WAIT);
    expect(getOutbox(a.paths, messageId)).toBeNull();

    // The target confirms delivery; the sender sees it.
    markDelivered(b.paths.inbox, messageId);
    await target.exchange();
    await vi.waitFor(() => expect(getSent(a.paths, messageId)?.state).toBe("delivered"), WAIT);
    expect(target.delivered).toEqual([messageId]);
    await Promise.all([sender.idle(), target.idle()]);
    sender.ws.close(1000, "done");
    target.ws.close(1000, "done");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("delivers a repeated send request once", async () => {
    const { root, a, b, messageId } = await twoNodes();
    const target = await start(b);
    const sender = await start(a);
    const frame = sender.client.sendMessage({ messageId, fromSession: "planner", to: { nodeId: b.nodeId, session: "review" },
      text: "please check the build" })[0];
    sender.ws.send(frame);
    sender.ws.send(frame);
    await sender.exchange();
    // A second process on the same node directory repeats it too.
    sender.inflight.clear();
    await sender.exchange();
    await vi.waitFor(() => expect(getSent(a.paths, messageId)?.state).toBe("accepted"), WAIT);
    await settle(300);
    await target.idle();
    expect(target.delivered).toEqual([messageId]);
    expect(messageIds(b.paths.inbox)).toEqual([messageId]);
    await sender.idle();
    sender.ws.close(1000, "done");
    target.ws.close(1000, "done");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("recovers a sender daemon crash between the socket send and recordSent", async () => {
    const { root, a, b, messageId } = await twoNodes();
    const target = await start(b);
    const crashed = await start(a);
    crashed.dropIncoming((type) => type === "message.status");
    await crashed.exchange();
    await vi.waitFor(() => expect(getMessage(b.paths.inbox, messageId)?.state).toBe("accepted"), WAIT);
    await crashed.crash();
    expect(getSent(a.paths, messageId)).toBeNull();

    const restarted = await start(a);
    await restarted.exchange();
    await vi.waitFor(() => expect(getSent(a.paths, messageId)?.state).toBe("accepted"), WAIT);
    expect(getOutbox(a.paths, messageId)).toBeNull();
    await target.idle();
    expect(target.delivered).toEqual([messageId]);
    await restarted.idle();
    restarted.ws.close(1000, "done");
    target.ws.close(1000, "done");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("recovers a target daemon crash between storing a message and reporting accepted", async () => {
    const { root, a, b, messageId } = await twoNodes();
    const crashed = await start(b);
    // The accepted answer never reaches the socket: the process ends first.
    crashed.muteOutgoing((type) => type === "message.status");
    const sender = await start(a);
    await sender.exchange();
    await vi.waitFor(() => expect(getMessage(b.paths.inbox, messageId)?.state).toBe("accepted"), WAIT);
    await crashed.crash();
    await vi.waitFor(() => expect(getSent(a.paths, messageId)?.state).toBe("queued"), WAIT);

    // The Worker kept it queued and hands it over again after authentication;
    // the stored inbox record is kept, so the session gets it once.
    const restarted = await start(b);
    await vi.waitFor(() => expect(getSent(a.paths, messageId)?.state).toBe("accepted"), WAIT);
    expect(restarted.delivered).toEqual([messageId]);
    expect(messageIds(b.paths.inbox)).toEqual([messageId]);
    markDelivered(b.paths.inbox, messageId);
    await restarted.exchange();
    await vi.waitFor(() => expect(getSent(a.paths, messageId)?.state).toBe("delivered"), WAIT);
    await Promise.all([sender.idle(), restarted.idle()]);
    sender.ws.close(1000, "done");
    restarted.ws.close(1000, "done");
    fs.rmSync(root, { recursive: true, force: true });
  });
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeEnvelope, parseEnvelope } from "../protocol.mts";
import { NodeClient } from "./client.mts";
import { deliverToClosed } from "./closed-delivery.mts";
import { audits, closedNode, PEER, SESSION, turnDone } from "./closed-fixture.mts";
import { nodePaths, readConfig, writeConfig } from "./config.mts";
import { getOutbox, readLocalSessions, writeDirectory } from "./exchange.mts";
import { generateIdentity } from "./identity.mts";
import { getMessage, storeMessage } from "./inbox.mts";
import { runMsg } from "./msg-cli.mts";
import { loadPolicy } from "./policy.mts";
import { T0 } from "./task-fixture.mts";

// Issue #107 end to end: msg send to the full id of a closed session the
// directory no longer lists leaves the sender, the target node accepts it into
// its inbox (it keys on toSession) and the closed-session round (#102, #105)
// hands it to a new intercom session. The Worker hop is played by copying the
// outbox record into a message.deliver frame, as the Worker does.

test("an unlisted full session id reaches the target inbox and the closed-session delivery", async (t) => {
  const node = closedNode(t);
  const target = readConfig(node.paths.config)!.nodeId;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-unlisted-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sender = nodePaths(root);
  fs.mkdirSync(sender.dir, { recursive: true });
  writeConfig(sender.config, { version: 1, controlUrl: "https://control.example.invalid", nodeId: PEER.nodeId, name: "mac", publicKey: "",
    privateKeyFile: "", policyFile: sender.policy, enrolledAt: new Date(T0).toISOString() });
  writeDirectory(sender, { nodes: [{ nodeId: target, name: "win", status: "online" }, { nodeId: PEER.nodeId, name: "mac", status: "online" }],
    sessions: [], fetchedAt: new Date(T0).toISOString() });
  const err: string[] = [];
  const out: string[] = [];
  const code = await runMsg(["send", "--from", PEER.session, `win/${SESSION}`, "--", "are the tests green?"],
    { paths: sender, env: { CLAUDE_CODE_SESSION_ID: PEER.session }, now: () => T0 - 10_000, out: (l) => out.push(l), err: (l) => err.push(l), sleep: async () => {} });
  assert.equal(code, 0, err.join("\n"));
  assert.match(err.join("\n"), /note: session not listed on win; the node decides whether it can deliver/);
  const record = getOutbox(sender, out[0])!;

  const client = new NodeClient({
    nodeId: target, identity: generateIdentity(), policy: loadPolicy(node.paths.policy),
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [] },
    facts: () => ({ hostname: "win.example.com", os: "win32", arch: "x64", cpus: 1, memoryBytes: 1 }),
    runtimes: async () => [], sessions: async () => [], localSessions: () => readLocalSessions(node.paths),
    storeMessage: (body) => { storeMessage(node.paths.inbox, body, T0 - 5_000); },
  });
  await client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)));
  const answer = await client.onFrame(JSON.stringify(makeEnvelope("message.deliver", { messageId: record.messageId,
    from: { nodeId: PEER.nodeId, session: record.fromSession }, toSession: record.to.session, text: record.text, createdAt: record.createdAt }, 0, 0)));
  assert.deepEqual(answer.map((f) => { const p = parseEnvelope(f); assert.ok(p.ok); return [p.envelope.type, p.envelope.body]; }),
    [["message.status", { messageId: record.messageId, state: "accepted" }]]);
  assert.equal(getMessage(node.paths.inbox, record.messageId)?.toSession, SESSION);

  await deliverToClosed(node.deps());
  const runs = node.calls.filter((c) => c.args[0] !== "agents");
  assert.equal(runs.length, 1);
  assert.ok(!runs[0].args.includes("--resume"), "the closed session itself is not resumed");
  assert.match(runs[0].args.at(-1)!, /are the tests green\?/);
  await turnDone(node);
  assert.equal(getMessage(node.paths.inbox, record.messageId)?.state, "delivered");
  assert.deepEqual(audits(node).map((a) => [a.action, a.outcome, a.sessionId, a.messageIds]),
    [["closed-session", "new", SESSION, [record.messageId]]]);
});

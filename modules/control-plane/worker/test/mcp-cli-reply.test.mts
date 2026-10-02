import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { digestMcpArguments, REMOTE_MCP_CAPABILITY, type McpTool } from "../../protocol-mcp.mts";
import { MESSAGING_CAPABILITY } from "../../protocol-messages.mts";
import { recordCodexSession } from "../../node/codex-sessions.mts";
import { nodePaths } from "../../node/config.mts";
import { getOutbox, writeLocalSessions } from "../../node/exchange.mts";
import { storeMessage } from "../../node/inbox.mts";
import { runMsgArgs } from "../../node/msg-cli.mts";
import { FACTS, newKey, registry } from "./helpers.mts";

const SOURCE = "019a2b3c-4d5e-7f60-8123-456789abcdea";
const TARGET = "019a2b3c-4d5e-7f60-8123-456789abcdef";

async function enrolled(sessionId: string) {
  const key = await newKey();
  const { code } = await registry().createEnrollment("test");
  const node = await registry().redeemEnrollment({ code, publicKey: key.publicKey, name: "synthetic", facts: FACTS,
    runtimes: [{ name: "codex", kind: "cli" }] });
  if (!node.ok) throw new Error(node.reason);
  await registry().updateRegistration(node.nodeId, FACTS, [{ name: "codex", kind: "cli" }],
    [REMOTE_MCP_CAPABILITY, MESSAGING_CAPABILITY]);
  await registry().replaceSessions(node.nodeId, [{ sessionId, runtime: "codex", state: "running" }]);
  const credential = await registry().rotateMcpCredential(node.nodeId);
  if (!credential.ok) throw new Error(credential.error);
  return { nodeId: node.nodeId, sessionId, version: credential.version };
}

async function intent(source: Awaited<ReturnType<typeof enrolled>>, tool: McpTool, args: unknown) {
  const registration = { requestId: crypto.randomUUID(), runtime: "codex" as const, sessionId: source.sessionId,
    threadId: source.sessionId, callId: crypto.randomUUID(), tool, argumentsDigest: await digestMcpArguments(args) };
  expect((await registry().registerMcpIntent(source.nodeId, registration)).ok).toBe(true);
  return { ...registration, nodeId: source.nodeId, credentialVersion: source.version };
}

it("a native MCP sender can reply to a full-ID CLI response without relaxing provenance", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-mcp-cli-reply-"));
  try {
    const a = await enrolled(SOURCE);
    const b = await enrolled(TARGET);
    const to = { nodeId: b.nodeId, session: TARGET };
    const first = await intent(a, "send", { to, text: "synthetic question" });
    expect((await registry().sendMcpMessage(first, to, "synthetic question")).ok).toBe(true);
    await registry().reportMessageStatus(b.nodeId, { messageId: first.requestId, state: "accepted" });

    const paths = nodePaths(root);
    recordCodexSession(paths, TARGET, root);
    writeLocalSessions(paths, [{ sessionId: TARGET, name: "codex-89abcdef", runtime: "codex", state: "running" }]);
    storeMessage(paths.inbox, { messageId: first.requestId, from: { nodeId: a.nodeId, session: SOURCE },
      toSession: TARGET, text: "synthetic question", createdAt: new Date().toISOString() });
    const out: string[] = [];
    const errors: string[] = [];
    expect(await runMsgArgs({ positionals: ["send", "synthetic answer"], values: { from: TARGET, "reply-to": first.requestId } },
      { paths, env: {}, out: (line) => out.push(line), err: (line) => errors.push(line) })).toBe(0);
    expect(errors).toEqual([]);
    const answer = getOutbox(paths, out[0]);
    expect(answer).not.toBeNull();
    if (!answer) throw new Error("CLI did not create a response");
    expect((await registry().sendMessage({ messageId: answer.messageId,
      from: { nodeId: b.nodeId, session: answer.fromSession }, to: answer.to, text: answer.text, inReplyTo: answer.inReplyTo },
    `node:${b.nodeId}`)).ok).toBe(true);
    await registry().reportMessageStatus(a.nodeId, { messageId: answer.messageId, state: "accepted" });

    const reply = await intent(a, "reply", { inReplyTo: answer.messageId, text: "synthetic acknowledgement" });
    expect(await registry().replyMcpMessage(reply, answer.messageId, "synthetic acknowledgement"))
      .toMatchObject({ ok: true, status: { messageId: reply.requestId, state: "queued" } });

    // A short display alias is not evidence that two full session identities match.
    const aliasId = crypto.randomUUID();
    expect((await registry().sendMessage({ messageId: aliasId, from: { nodeId: b.nodeId, session: "codex-89abcdef" },
      to: { nodeId: a.nodeId, session: SOURCE }, text: "synthetic legacy alias", inReplyTo: first.requestId },
    `node:${b.nodeId}`)).ok).toBe(true);
    await registry().reportMessageStatus(a.nodeId, { messageId: aliasId, state: "accepted" });
    const denied = await intent(a, "reply", { inReplyTo: aliasId, text: "must not send" });
    expect(await registry().replyMcpMessage(denied, aliasId, "must not send"))
      .toEqual({ ok: false, error: "reply relationship or depth is not allowed" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

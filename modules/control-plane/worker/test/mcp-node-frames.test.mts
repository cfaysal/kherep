import { describe, expect, it } from "vitest";

import { makeEnvelope } from "../../protocol.mts";
import { REMOTE_MCP_CAPABILITY, digestMcpArguments } from "../../protocol-mcp.mts";
import { FACTS, authenticate, enroll, newKey, registry } from "./helpers.mts";

describe("authenticated node remote MCP frames", () => {
  it("provisions a bearer and durably acknowledges intent metadata only after authenticated opt-in", async () => {
    const key = await newKey();
    const nodeId = await enroll(key, "mcp-node");
    const socket = await authenticate(nodeId, key);
    socket.send(makeEnvelope("register", { facts: FACTS, runtimes: [{ name: "codex", kind: "cli" }],
      capabilities: [REMOTE_MCP_CAPABILITY] }, 1, 0));
    socket.send(makeEnvelope("sessions.snapshot", { sessions: [{ sessionId: "native-session", runtime: "codex", state: "running" }] }, 2, 0));

    const rotationId = "50000000-0000-4000-8000-000000000001";
    socket.send(makeEnvelope("mcp.credential.rotate", { requestId: rotationId }, 3, 0));
    const provisioned = await socket.next();
    expect(provisioned.type).toBe("mcp.credential");
    const credential = provisioned.body as { ok: boolean; token?: string; version?: number };
    expect(credential.ok).toBe(true);
    expect(await registry().authenticateMcpCredential(credential.token ?? "")).toEqual({ nodeId, version: 1 });

    const requestId = "50000000-0000-4000-8000-000000000002";
    const body = { requestId, runtime: "codex", sessionId: "native-session", callId: "native-call", tool: "sessions",
      argumentsDigest: await digestMcpArguments({ limit: 3 }) };
    socket.send(makeEnvelope("mcp.intent.register", body, 4, 0));
    const receipt = await socket.next();
    expect(receipt.type).toBe("mcp.intent.receipt");
    expect(receipt.body).toMatchObject({ requestId, ok: true, version: 1 });
  });

  it("refuses credential provisioning when the authenticated node did not opt in", async () => {
    const key = await newKey();
    const nodeId = await enroll(key, "mcp-disabled-node");
    const socket = await authenticate(nodeId, key);
    const requestId = "50000000-0000-4000-8000-000000000003";
    socket.send(makeEnvelope("mcp.credential.rotate", { requestId }, 1, 0));
    const response = await socket.next();
    expect(response.type).toBe("mcp.credential");
    expect(response.body).toEqual({ requestId, ok: false, error: "remote MCP is not enabled for this node" });
  });
});

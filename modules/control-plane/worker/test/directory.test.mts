import { describe, expect, it } from "vitest";

import { makeEnvelope, MAX_FRAME_BYTES } from "../../protocol.mts";
import { isDirectoryBody, type DirectoryBody } from "../../protocol-messages.mts";
import { directoryBody } from "../src/directory.mts";
import { authenticate, enroll, newKey, registry } from "./helpers.mts";

describe("directory frames", () => {
  it("answers directory.get with the non-revoked nodes and their sessions", async () => {
    const a = await newKey();
    const b = await newKey();
    const c = await newKey();
    const aId = await enroll(a, "dir-a");
    const bId = await enroll(b, "dir-b");
    const cId = await enroll(c, "dir-c");
    await registry().replaceSessions(bId, [{ sessionId: "s-b", runtime: "claude-code", state: "idle", name: "review", cwd: "/work",
      startedAt: new Date(0).toISOString() }]);
    await registry().revoke(cId, "test");
    // Revocation deletes the sessions; a late snapshot must not bring the node back.
    await registry().replaceSessions(cId, [{ sessionId: "s-c", runtime: "claude-code", state: "idle" }]);

    const socket = await authenticate(aId, a);
    socket.send(makeEnvelope("directory.get", {}, 1, 0));
    const reply = await socket.next();
    expect(reply.type).toBe("directory");
    expect(isDirectoryBody(reply.body)).toBe(true);
    const body = reply.body as DirectoryBody;
    const ids = body.nodes.map((n) => n.nodeId);
    expect(ids).toEqual(expect.arrayContaining([aId, bId]));
    expect(ids).not.toContain(cId);
    expect(body.nodes.find((n) => n.nodeId === aId)).toEqual({ nodeId: aId, name: "dir-a", status: "online" });
    expect(body.sessions.filter((s) => s.nodeId === bId)).toEqual(
      [{ nodeId: bId, sessionId: "s-b", runtime: "claude-code", state: "idle", name: "review", cwd: "/work" }]);
    expect(body.sessions.some((s) => s.nodeId === cId)).toBe(false);
    expect(body.truncated).toBeUndefined();

    socket.send(makeEnvelope("directory.get", { everything: true }, 2, 0));
    expect(await socket.next()).toMatchObject({ type: "error", body: { error: "invalid directory.get body" } });
    socket.ws.close(1000, "done");
  });

  it("drops sessions from the end so the directory fits into one frame", () => {
    const nodeId = crypto.randomUUID();
    const sessions = Array.from({ length: 400 }, (_, i) => ({ nodeId, sessionId: `s-${i}`, runtime: "claude-code", state: "idle",
      cwd: `/${"x".repeat(400)}` }));
    const body = directoryBody([{ id: nodeId, name: "big", status: "online" }], sessions, 0);
    expect(body.truncated).toBe(true);
    expect(body.sessions.length).toBeGreaterThan(0);
    expect(JSON.stringify(makeEnvelope("directory", body, 0, 0)).length).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    expect(isDirectoryBody(body)).toBe(true);
  });
});

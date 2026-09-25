import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { makeEnvelope } from "../../protocol.mts";
import vectors from "../../test-vectors.json";
import { verifyChallenge } from "../src/crypto.mts";
import { CLOSE, type Attachment } from "../src/handshake.mts";
import { authenticate, connect, enroll, newKey, registry, session, signAuth, vectorKey } from "./helpers.mts";

describe("challenge handshake", () => {
  it("verifies the signature the node implementation produced for the shared test vector", async () => {
    const { publicKey, nodeId, nonce, timestamp, signature } = vectors;
    expect(await verifyChallenge(publicKey, { nodeId, nonce, timestamp, signature })).toBe(true);
    expect(await verifyChallenge(publicKey, { nodeId, nonce, timestamp: timestamp + 1, signature })).toBe(false);
  });

  it("accepts a valid signature from an enrolled node and marks it online", async () => {
    const key = await vectorKey();
    const nodeId = await enroll(key);
    const socket = await authenticate(nodeId, key);
    expect((await registry().getNode(nodeId))?.status).toBe("online");
    socket.ws.close(1000, "done");
  });

  it("rejects a signature from another key", async () => {
    const nodeId = await enroll(await vectorKey());
    const { socket, challenge } = await connect(nodeId);
    socket.send(makeEnvelope("auth", await signAuth(await newKey(), nodeId, challenge.nonce), 0, 0));
    expect((await socket.closed).code).toBe(CLOSE.badSignature);
  });

  it("rejects a node that was never enrolled", async () => {
    const key = await newKey();
    const nodeId = crypto.randomUUID();
    const { socket, challenge } = await connect(nodeId);
    socket.send(makeEnvelope("auth", await signAuth(key, nodeId, challenge.nonce), 0, 0));
    expect((await socket.closed).code).toBe(CLOSE.unknownOrRevoked);
  });

  it("rejects a revoked key", async () => {
    const key = await newKey();
    const nodeId = await enroll(key);
    expect(await registry().revoke(nodeId, "test")).not.toBeNull();
    await session(nodeId).revoke();
    const { socket, challenge } = await connect(nodeId);
    socket.send(makeEnvelope("auth", await signAuth(key, nodeId, challenge.nonce), 0, 0));
    expect((await socket.closed).code).toBe(CLOSE.unknownOrRevoked);
  });

  it("rejects an auth message replayed on a new connection", async () => {
    const key = await newKey();
    const nodeId = await enroll(key);
    const first = await connect(nodeId);
    const captured = makeEnvelope("auth", await signAuth(key, nodeId, first.challenge.nonce), 0, 0);
    first.socket.send(captured);
    expect((await first.socket.next()).type).toBe("event");
    const second = await connect(nodeId);
    expect(second.challenge.nonce).not.toBe(first.challenge.nonce);
    second.socket.send(captured);
    expect((await second.socket.closed).code).toBe(CLOSE.badSignature);
  });

  it("rejects an expired nonce", async () => {
    const key = await newKey();
    const nodeId = await enroll(key);
    const { socket, challenge } = await connect(nodeId);
    // Age the nonce in the connection attachment instead of sleeping 30 s.
    await runInDurableObject(session(nodeId), (_instance, state) => {
      for (const ws of state.getWebSockets()) {
        const attachment = ws.deserializeAttachment() as Attachment;
        ws.serializeAttachment({ ...attachment, nonceIssuedAt: Date.now() - 60_000 });
      }
    });
    socket.send(makeEnvelope("auth", await signAuth(key, nodeId, challenge.nonce), 0, 0));
    expect((await socket.closed).code).toBe(CLOSE.nonceExpired);
  });

  it("rejects a signed timestamp outside the clock-skew window", async () => {
    const key = await newKey();
    const nodeId = await enroll(key);
    const { socket, challenge } = await connect(nodeId);
    socket.send(makeEnvelope("auth", await signAuth(key, nodeId, challenge.nonce, Date.now() - 5 * 60_000), 0, 0));
    expect((await socket.closed).code).toBe(CLOSE.nonceExpired);
  });

  it("closes a connection that sends anything but auth first", async () => {
    const nodeId = await enroll(await newKey());
    const { socket } = await connect(nodeId);
    socket.send(makeEnvelope("event", { name: "hello" }, 1, 0));
    expect((await socket.closed).code).toBe(CLOSE.protocol);
  });
});

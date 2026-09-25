import assert from "node:assert/strict";
import test from "node:test";

import {
  fromBase64Url, isPhase1Command, makeEnvelope, MAX_FRAME_BYTES, parseEnvelope, PHASE1_COMMANDS, toBase64Url,
} from "./protocol.mts";

test("round-trips an envelope and rejects malformed ones", () => {
  const envelope = makeEnvelope("event", { name: "x" }, 3, 2);
  assert.deepEqual(parseEnvelope(JSON.stringify(envelope)), { ok: true, envelope });
  const bad = (value: unknown) => parseEnvelope(JSON.stringify(value)).ok;
  assert.equal(bad({ ...envelope, v: 2 }), false);
  assert.equal(bad({ ...envelope, type: "shell" }), false);
  assert.equal(bad({ ...envelope, seq: -1 }), false);
  assert.equal(bad({ ...envelope, ack: 1.5 }), false);
  assert.equal(bad({ ...envelope, ts: "yesterday" }), false);
  assert.equal(bad({ ...envelope, body: [] }), false);
  assert.equal(parseEnvelope("not json").ok, false);
  assert.equal(parseEnvelope(new ArrayBuffer(4)).ok, false);
  assert.equal(parseEnvelope(" ".repeat(MAX_FRAME_BYTES + 1)).ok, false);
});

test("the Phase 1 command set is exactly three read-only commands", () => {
  assert.deepEqual([...PHASE1_COMMANDS], ["node.status", "runtime.list", "session.list"]);
  assert.equal(isPhase1Command("session.start"), false);
  assert.equal(isPhase1Command("NODE.STATUS"), false);
});

test("base64url encoding round-trips all byte values", () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
  const text = toBase64Url(bytes);
  assert.match(text, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(fromBase64Url(text), bytes);
  assert.throws(() => fromBase64Url("a+b/"));
});

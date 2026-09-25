import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { generateIdentity, identityFromSeed, readPrivateKey, signChallenge, verifyChallenge, writePrivateKey } from "./identity.mts";

// Shared with the Worker tests (worker/test/handshake.test.mts), which verify
// the same signature with WebCrypto.
const vectors = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "test-vectors.json"), "utf8")) as {
  seedHex: string; publicKey: string; nodeId: string; nonce: string; timestamp: number; signature: string;
};

test("signs the challenge exactly as the shared test vector expects", () => {
  const identity = identityFromSeed(Buffer.from(vectors.seedHex, "hex"), vectors.publicKey);
  assert.equal(identity.publicKey, vectors.publicKey);
  const auth = signChallenge(identity, vectors.nodeId, vectors.nonce, vectors.timestamp);
  // Ed25519 is deterministic, so the node must produce the vector byte for byte.
  assert.equal(auth.signature, vectors.signature);
  assert.equal(verifyChallenge(vectors.publicKey, auth), true);
  assert.equal(verifyChallenge(vectors.publicKey, { ...auth, nodeId: "00000000-0000-4000-8000-000000000002" }), false);
});

test("generates a fresh Ed25519 identity with a 32-byte raw public key", () => {
  const identity = generateIdentity();
  assert.equal(Buffer.from(identity.publicKey, "base64url").length, 32);
  const auth = signChallenge(identity, vectors.nodeId, "bm9uY2U", Date.now());
  assert.equal(verifyChallenge(identity.publicKey, auth), true);
  assert.notEqual(generateIdentity().publicKey, identity.publicKey);
});

test("stores the private key with mode 0600 and never overwrites it", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-node-key-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "node-ed25519.pem");
  const identity = generateIdentity();
  writePrivateKey(file, identity);
  assert.equal(readPrivateKey(file).publicKey, identity.publicKey);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => writePrivateKey(file, generateIdentity()), /EEXIST/);
  assert.equal(readPrivateKey(file).publicKey, identity.publicKey);
});

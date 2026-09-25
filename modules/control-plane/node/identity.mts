import crypto from "node:crypto";
import fs from "node:fs";

import { challengeMessage, fromBase64Url, toBase64Url, type AuthBody } from "../protocol.mts";

// Ed25519 node identity (issue #5, design section 2). The private key never
// leaves the host; the control plane only ever sees the raw public key.
export interface NodeIdentity {
  privateKey: crypto.KeyObject;
  publicKey: string; // 32 raw bytes, base64url, as the Worker imports it
}

export function publicKeyOf(privateKey: crypto.KeyObject): string {
  const jwk = crypto.createPublicKey(privateKey).export({ format: "jwk" });
  if (jwk.crv !== "Ed25519" || typeof jwk.x !== "string") throw new Error("not an Ed25519 key");
  return jwk.x;
}

export function generateIdentity(): NodeIdentity {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  return { privateKey, publicKey: publicKeyOf(privateKey) };
}

// Test-vector support: a key from its 32-byte seed (RFC 8032 notation).
export function identityFromSeed(seed: Uint8Array, publicKey: string): NodeIdentity {
  const privateKey = crypto.createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: toBase64Url(seed), x: publicKey }, format: "jwk" });
  return { privateKey, publicKey: publicKeyOf(privateKey) };
}

export function signChallenge(identity: NodeIdentity, nodeId: string, nonce: string, timestamp = Date.now()): AuthBody {
  const signature = crypto.sign(null, challengeMessage(nonce, nodeId, timestamp), identity.privateKey);
  return { nodeId, nonce, timestamp, signature: toBase64Url(signature) };
}

export function verifyChallenge(publicKey: string, auth: AuthBody): boolean {
  const key = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
  return crypto.verify(null, challengeMessage(auth.nonce, auth.nodeId, auth.timestamp), key, fromBase64Url(auth.signature));
}

// Writes the private key as PKCS#8 PEM with mode 0600. The mode applies on
// POSIX systems; on Windows the file inherits the ACL of the per-user config
// directory. Refuses to overwrite an existing key.
export function writePrivateKey(file: string, identity: NodeIdentity): void {
  const pem = identity.privateKey.export({ type: "pkcs8", format: "pem" });
  fs.writeFileSync(file, pem, { mode: 0o600, flag: "wx" });
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
}

export function readPrivateKey(file: string): NodeIdentity {
  const privateKey = crypto.createPrivateKey(fs.readFileSync(file));
  return { privateKey, publicKey: publicKeyOf(privateKey) };
}

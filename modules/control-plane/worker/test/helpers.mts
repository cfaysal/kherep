import { env, exports } from "cloudflare:workers";

import {
  challengeMessage, makeEnvelope, parseEnvelope, toBase64Url, type AuthBody, type ChallengeBody, type Envelope,
} from "../../protocol.mts";
import vectors from "../../test-vectors.json";
import type { Env } from "../src/env.mts";

// Types the `env` and `exports` of "cloudflare:workers" for the tests.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
    interface GlobalProps { mainModule: typeof import("../src/index.mts") }
  }
}
type WorkerEnv = Env;

export const BASE = "https://control.example.com";
export const FACTS = { hostname: "node-a.example.com", os: "linux", arch: "x64", cpus: 4, memoryBytes: 8 * 1024 ** 3 };

export interface NodeKey { publicKey: string; privateKey: CryptoKey }

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (byte) => parseInt(byte, 16));
}

// The RFC 8032 key shared with the node tests (modules/control-plane/test-vectors.json).
export async function vectorKey(): Promise<NodeKey> {
  const jwk = { kty: "OKP", crv: "Ed25519", d: toBase64Url(hexToBytes(vectors.seedHex)), x: vectors.publicKey };
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
  return { publicKey: vectors.publicKey, privateKey };
}

export async function newKey(): Promise<NodeKey> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer;
  return { publicKey: toBase64Url(new Uint8Array(raw)), privateKey: pair.privateKey };
}

export async function signAuth(key: NodeKey, nodeId: string, nonce: string, timestamp = Date.now()): Promise<AuthBody> {
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, challengeMessage(nonce, nodeId, timestamp));
  return { nodeId, nonce, timestamp, signature: toBase64Url(new Uint8Array(signature)) };
}

export function registry() {
  return env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
}

export function session(nodeId: string) {
  return env.NODE_SESSION.get(env.NODE_SESSION.idFromName(nodeId));
}

export async function workerFetch(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`${BASE}${path}`, init));
}

export async function enrollWithCode(code: string, key: NodeKey, name = "node-a"): Promise<Response> {
  return workerFetch("/node/enroll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, publicKey: key.publicKey, name, facts: FACTS, runtimes: [{ name: "claude", kind: "cli" }] }),
  });
}

export async function enroll(key: NodeKey, name = "node-a"): Promise<string> {
  const { code } = await registry().createEnrollment("test");
  const response = await enrollWithCode(code, key, name);
  if (response.status !== 201) throw new Error(`enroll failed: ${response.status}`);
  return ((await response.json()) as { nodeId: string }).nodeId;
}

// A client WebSocket inside workerd with a queue of received envelopes.
export class TestSocket {
  readonly ws: WebSocket;
  readonly closed: Promise<{ code: number; reason: string }>;
  private readonly queue: Envelope[] = [];
  private waiters: ((envelope: Envelope) => void)[] = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.closed = new Promise((resolve) => ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason })));
    ws.addEventListener("message", (event) => {
      const parsed = parseEnvelope(event.data as string);
      if (!parsed.ok) return;
      const waiter = this.waiters.shift();
      if (waiter) waiter(parsed.envelope);
      else this.queue.push(parsed.envelope);
    });
    ws.accept();
  }

  next(timeoutMs = 2000): Promise<Envelope> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no message")), timeoutMs);
      this.waiters.push((envelope) => { clearTimeout(timer); resolve(envelope); });
    });
  }

  send(envelope: Envelope): void {
    this.ws.send(JSON.stringify(envelope));
  }
}

export async function connect(nodeId: string): Promise<{ socket: TestSocket; challenge: ChallengeBody }> {
  const response = await workerFetch(`/node/connect?nodeId=${nodeId}`, { headers: { upgrade: "websocket" } });
  if (response.status !== 101 || !response.webSocket) throw new Error(`upgrade failed: ${response.status}`);
  const socket = new TestSocket(response.webSocket);
  const first = await socket.next();
  if (first.type !== "challenge") throw new Error(`expected challenge, got ${first.type}`);
  return { socket, challenge: first.body as ChallengeBody };
}

export async function authenticate(nodeId: string, key: NodeKey, ack = 0): Promise<TestSocket> {
  const { socket, challenge } = await connect(nodeId);
  socket.send(makeEnvelope("auth", await signAuth(key, nodeId, challenge.nonce), 0, ack));
  const reply = await socket.next();
  if (reply.type !== "event" || (reply.body as { name?: string }).name !== "auth.ok") throw new Error("auth rejected");
  return socket;
}

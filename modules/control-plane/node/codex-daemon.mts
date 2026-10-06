import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { isCodexSessionId } from "./codex-sessions.mts";

// Which Desktop-classified Codex threads are interactive TUIs on the shared
// app-server daemon (issue #268). Measured 2026-10-06 on macOS, Codex 0.160:
// a TUI's rollout starts like a Desktop chat's, but the TUI thread is loaded on
// the managed daemon (`thread/loaded/list` over its control socket, a
// WebSocket over a unix socket) and has a marker file
// <codex home>/tui-thread-reference-capabilities/<thread id>; Desktop threads
// have neither. Only both together count. Every failure means "unknown", and
// unknown keeps the Desktop behaviour. The Windows topology is unknown, so
// the probe never connects there.

const PROBE_TIMEOUT_MS = 2_000;
export const LOADED_TTL_MS = 10_000;
// The largest daemon answer read; a longer one is refused.
const MAX_BYTES = 1024 * 1024;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export type LoadedThreads = () => Promise<Set<string> | null>;

export const daemonSocket = (home: string): string => path.join(home, "app-server-control", "app-server-control.sock");
export const tuiMarker = (home: string, threadId: string): string => path.join(home, "tui-thread-reference-capabilities", threadId);

// A masked client frame (RFC 6455 5.2); the messages here stay below 64 KiB.
function clientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = crypto.randomBytes(4);
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, 0x80 | len]) : Buffer.from([0x80 | opcode, 0x80 | 126, len >> 8, len & 0xff]);
  return Buffer.concat([head, mask, Buffer.from(payload.map((b, i) => b ^ mask[i % 4]))]);
}

// One complete server frame at the start of buffer, or null when more bytes are needed.
function serverFrame(buffer: Buffer): { fin: boolean; opcode: number; payload: Buffer; size: number } | null {
  if (buffer.length < 2) return null;
  if (buffer[1] & 0x80) throw new Error("a server frame is masked");
  let len = buffer[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buffer.length < 4) return null;
    len = buffer.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buffer.length < 10) return null;
    const big = buffer.readBigUInt64BE(2);
    if (big > BigInt(MAX_BYTES)) throw new Error("a server frame is too large");
    len = Number(big);
    offset = 10;
  }
  if (buffer.length < offset + len) return null;
  return { fin: (buffer[0] & 0x80) !== 0, opcode: buffer[0] & 0x0f, payload: buffer.subarray(offset, offset + len), size: offset + len };
}

// The thread ids loaded on the daemon behind socket, or null on any failure:
// no socket, a refused connection, no 101 upgrade, an error answer, a partial
// list, anything unparseable, or no answer within timeoutMs.
export function loadedThreads(socket: string, options: { platform?: NodeJS.Platform; timeoutMs?: number } = {}): Promise<Set<string> | null> {
  if ((options.platform ?? process.platform) === "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString("base64");
    const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
    const conn = net.connect({ path: socket });
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    let parts: Buffer[] = [];
    let done = false;
    const finish = (result: Set<string> | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      conn.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), options.timeoutMs ?? PROBE_TIMEOUT_MS);
    const send = (message: Record<string, unknown>): void => { conn.write(clientFrame(0x1, Buffer.from(JSON.stringify(message)))); };
    const answer = (message: { id?: unknown; result?: unknown; error?: unknown }): void => {
      if (message.id !== 1 && message.id !== 2) return;
      if (message.error !== undefined || typeof message.result !== "object" || message.result === null) return finish(null);
      if (message.id === 1) {
        send({ method: "initialized" });
        return send({ id: 2, method: "thread/loaded/list", params: {} });
      }
      const { data, nextCursor } = message.result as { data?: unknown; nextCursor?: unknown };
      if (nextCursor !== null && nextCursor !== undefined) return finish(null);
      if (!Array.isArray(data) || !data.every((id): id is string => typeof id === "string")) return finish(null);
      finish(new Set(data));
    };
    const read = (): void => {
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const [status, ...headers] = buffer.subarray(0, end).toString("latin1").split("\r\n");
        buffer = buffer.subarray(end + 4);
        const accepted = headers.some((line) => {
          const colon = line.indexOf(":");
          return line.slice(0, colon).trim().toLowerCase() === "sec-websocket-accept" && line.slice(colon + 1).trim() === accept;
        });
        if (!/^HTTP\/1\.1 101\b/.test(status) || !accepted) return finish(null);
        upgraded = true;
        send({ id: 1, method: "initialize", params: { clientInfo: { name: "kherep", title: null, version: "1" }, capabilities: null } });
      }
      for (let frame = serverFrame(buffer); frame && !done; frame = serverFrame(buffer)) {
        buffer = buffer.subarray(frame.size);
        if (frame.opcode === 0x9) conn.write(clientFrame(0xa, frame.payload));
        if (frame.opcode === 0x9 || frame.opcode === 0xa) continue;
        if (frame.opcode !== 0x1 && frame.opcode !== 0x0) return finish(null);
        parts.push(frame.payload);
        if (!frame.fin) continue;
        const text = Buffer.concat(parts).toString("utf8");
        parts = [];
        answer(JSON.parse(text));
      }
    };
    conn.on("connect", () => {
      conn.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    conn.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_BYTES) return finish(null);
      try {
        read();
      } catch {
        finish(null);
      }
    });
    conn.on("error", () => finish(null));
    conn.on("close", () => finish(null));
  });
}

// The last probe result per Codex home, and the probes still running.
const cache = new Map<string, { at: number; threads: Set<string> | null }>();
const probing = new Map<string, Promise<void>>();

// Resolves once every probe started so far has settled (tests, shutdown).
export async function probesSettled(): Promise<void> {
  await Promise.all(probing.values());
}

function refresh(home: string, probe: LoadedThreads, now: number): void {
  if (probing.has(home)) return;
  const run = Promise.resolve().then(probe).catch(() => null)
    .then((threads) => { cache.set(home, { at: now, threads }); })
    .finally(() => { probing.delete(home); });
  probing.set(home, run);
}

// For one round at now: whether a Desktop-classified thread is a TUI reachable
// on the shared daemon. Synchronous: it reads the cached probe result and,
// for a thread with a marker but no fresh result, starts a probe whose answer
// a later round uses.
export function tuiReachability(home: string, probe: LoadedThreads, now: number): (threadId: string) => boolean {
  return (threadId) => {
    if (!isCodexSessionId(threadId) || !fs.existsSync(tuiMarker(home, threadId))) return false;
    const entry = cache.get(home);
    if (entry && now >= entry.at && now - entry.at < LOADED_TTL_MS) return entry.threads?.has(threadId) ?? false;
    refresh(home, probe, now);
    return false;
  };
}

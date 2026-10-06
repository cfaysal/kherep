import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { daemonSocket, loadedThreads, LOADED_TTL_MS, probesSettled, tuiMarker, tuiReachability, type LoadedThreads } from "./codex-daemon.mts";

// The Codex app-server daemon probe (issue #268) against a fake WebSocket
// server on a unix socket in a temporary Codex home. The real daemon socket
// is never touched.

const TUI = "01a11070-0000-7000-8000-00000000a268";
const DESKTOP = "01a11070-0000-7000-8000-00000000d268";
const POSIX = { skip: process.platform === "win32" ? "unix sockets only" : false };

// A short base: unix socket paths are limited to about 104 bytes.
function home(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "kd-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(daemonSocket(dir)), { recursive: true });
  return dir;
}

// Server frames are unmasked; client frames are masked (RFC 6455 5.1).
function serverFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  const head = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([head, payload]);
}

function clientFrames(buffer: Buffer): { messages: unknown[]; rest: Buffer } {
  const messages: unknown[] = [];
  for (;;) {
    if (buffer.length < 2) break;
    assert.ok(buffer[1] & 0x80, "client frames are masked");
    let len = buffer[1] & 0x7f;
    let offset = 2;
    if (len === 126) { len = buffer.readUInt16BE(2); offset = 4; }
    if (buffer.length < offset + 4 + len) break;
    const mask = buffer.subarray(offset, offset + 4);
    const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + len).map((b, i) => b ^ mask[i % 4]));
    messages.push(JSON.parse(payload.toString("utf8")));
    buffer = buffer.subarray(offset + 4 + len);
  }
  return { messages, rest: buffer };
}

type Mode = "list" | "forbidden" | "silent" | "partial" | "error";

// A fake daemon answering by mode; records what the client sent and whether it closed.
async function fakeDaemon(t: test.TestContext, dir: string, mode: Mode, ids: string[] = []) {
  const seen = { connections: 0, closed: 0, sent: [] as Record<string, unknown>[] };
  const server = net.createServer((socket) => {
    seen.connections++;
    socket.on("close", () => { seen.closed++; });
    socket.on("error", () => {});
    let buffer: Buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const key = /sec-websocket-key:\s*(\S+)/i.exec(buffer.subarray(0, end).toString("latin1"))?.[1] ?? "";
        buffer = buffer.subarray(end + 4);
        if (mode === "silent") return;
        if (mode === "forbidden") return void socket.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
        const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        upgraded = true;
      }
      const { messages, rest } = clientFrames(buffer);
      buffer = rest;
      for (const message of messages as Record<string, unknown>[]) {
        seen.sent.push(message);
        if (message.method === "initialize") socket.write(serverFrame(JSON.stringify({ id: message.id, result: { userAgent: "fake" } })));
        if (message.method !== "thread/loaded/list") continue;
        socket.write(serverFrame(JSON.stringify({ method: "thread/started", params: {} })));
        const reply = mode === "error" ? { error: { code: -32600, message: "no" } }
          : { result: { data: ids, nextCursor: mode === "partial" ? "more" : null } };
        socket.write(serverFrame(JSON.stringify({ id: message.id, ...reply })));
      }
    });
  });
  await new Promise<void>((resolve) => { server.listen(daemonSocket(dir), resolve); });
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));
  return seen;
}

const waitClosed = async (seen: { connections: number; closed: number }): Promise<void> => {
  for (let n = 0; n < 100 && seen.closed < seen.connections; n++) await new Promise((r) => { setTimeout(r, 10); });
  assert.equal(seen.closed, seen.connections, "the probe closes its connection");
};

test("the probe lists the threads loaded on the daemon and closes the socket", POSIX, async (t) => {
  const dir = home(t);
  const ids = [TUI, "01a11070-0000-7000-8000-00000000b268", "01a11070-0000-7000-8000-00000000c268"];
  const seen = await fakeDaemon(t, dir, "list", ids);
  assert.deepEqual(await loadedThreads(daemonSocket(dir)), new Set(ids));
  assert.deepEqual(seen.sent.map((m) => m.method), ["initialize", "initialized", "thread/loaded/list"]);
  assert.equal((seen.sent[0].params as { clientInfo: { name: string } }).clientInfo.name, "kherep");
  await waitClosed(seen);
});

test("the probe fails closed to null on a missing socket, a non-socket, 403, an error, a partial list and a timeout", POSIX, async (t) => {
  const dir = home(t);
  assert.equal(await loadedThreads(daemonSocket(dir)), null, "ENOENT");
  fs.writeFileSync(daemonSocket(dir), "");
  assert.equal(await loadedThreads(daemonSocket(dir)), null, "not a socket");
  for (const mode of ["forbidden", "error", "partial", "silent"] as Mode[]) {
    const other = home(t);
    const seen = await fakeDaemon(t, other, mode, [TUI]);
    const started = Date.now();
    assert.equal(await loadedThreads(daemonSocket(other), { timeoutMs: 300 }), null, mode);
    assert.ok(Date.now() - started < 2_000, `${mode} ends within the timeout`);
    await waitClosed(seen);
  }
});

test("on win32 the probe returns null without connecting", async (t) => {
  const dir = home(t);
  const seen = process.platform === "win32" ? { connections: 0 } : await fakeDaemon(t, dir, "list", [TUI]);
  assert.equal(await loadedThreads(daemonSocket(dir), { platform: "win32" }), null);
  assert.equal(seen.connections, 0);
});

test("reachability needs the marker and a fresh loaded set; the probe result is cached", async (t) => {
  const dir = home(t);
  fs.mkdirSync(path.dirname(tuiMarker(dir, TUI)), { recursive: true });
  fs.writeFileSync(tuiMarker(dir, TUI), "");
  let calls = 0;
  const probe: LoadedThreads = async () => { calls++; return new Set([TUI, DESKTOP]); };
  const t0 = 1_000_000;
  assert.equal(tuiReachability(dir, probe, t0)(TUI), false, "unknown before the first probe");
  await probesSettled();
  const now = tuiReachability(dir, probe, t0 + 1_000);
  assert.equal(now(TUI), true);
  assert.equal(now(DESKTOP), false, "loaded without a marker");
  assert.equal(now("../x"), false);
  assert.equal(calls, 1, "a marker-less thread starts no probe and a fresh result is reused");
  assert.equal(tuiReachability(dir, probe, t0 + LOADED_TTL_MS)(TUI), false, "stale: unknown again");
  await probesSettled();
  assert.equal(calls, 2);
  const failing = home(t);
  fs.mkdirSync(path.dirname(tuiMarker(failing, TUI)), { recursive: true });
  fs.writeFileSync(tuiMarker(failing, TUI), "");
  tuiReachability(failing, () => { throw new Error("probe failed"); }, t0)(TUI);
  await probesSettled();
  assert.equal(tuiReachability(failing, probe, t0 + 1)(TUI), false, "a failed probe counts as unknown until it is stale");
});

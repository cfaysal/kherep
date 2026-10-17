import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import test from "node:test";

import { readDaemonState } from "./daemon-state.mts";
import { EXCHANGE_INTERVAL_MS } from "./exchange.mts";
import { getMessage } from "./inbox.mts";
import { enqueueMcpIntent } from "./mcp-local.mts";
import { AUTH_OK, command, deliver, flush, intakeHarness, messageId, statuses } from "./daemon-intake-fixture.mts";

// Issue #441: a message.deliver frame is stored on an intake lane of its own,
// so it no longer waits behind awaited runtime work on the frame lane. Policy
// acceptance, the store and the no-answer-on-store-failure rule are unchanged.

const CLAUDE_TARGET = "synthetic-claude-session";
const CODEX_TARGET = "01a0db01-0000-7000-8000-0000000000c1";

test("queued deliveries are stored and acknowledged while the frame lane is held by a slow command", async (t) => {
  const h = intakeHarness(t);
  await flush();
  const socket = h.socket();
  socket.message(AUTH_OK);
  await flush();
  socket.message(command(1, "session.list"));
  await flush();
  for (const n of [1, 2, 3]) socket.message(deliver(n, CLAUDE_TARGET));
  await flush();
  for (const n of [1, 2, 3]) {
    assert.ok(getMessage(h.paths.inbox, messageId(n))?.receivedAt, `delivery ${n} is stored while the command is pending`);
    assert.equal(statuses(socket, messageId(n)).length, 1, `delivery ${n} is acknowledged while the command is pending`);
  }
  assert.equal(socket.sent.some((f) => f.type === "command.result"), false, "the command is still pending");
  h.release();
  await flush();
  assert.equal(socket.sent.filter((f) => f.type === "command.ack").length, 1);
  assert.equal(socket.sent.filter((f) => f.type === "command.result").length, 1);
  const seqs = socket.sent.map((f) => f.seq);
  assert.ok(seqs.every((seq, i) => seq > 0 && (i === 0 || seq > seqs[i - 1]!)), `strictly increasing seq in send order: ${seqs.join(",")}`);
});

test("a delivery is stored while an exchange round awaits MCP session discovery", async (t) => {
  const h = intakeHarness(t, { policy: { version: 1, allowedCommands: [], remoteMcp: { enabled: true },
    messaging: { accept: [{ from: ["*"], session: "*" }] } } });
  await flush();
  const socket = h.socket();
  socket.message(AUTH_OK);
  await flush();
  enqueueMcpIntent(h.paths, { requestId: "40000000-0000-4000-8000-000000000001", runtime: "codex",
    sessionId: "synthetic-unlisted", callId: "synthetic-native-call", tool: "status", argumentsDigest: "a".repeat(64) });
  const before = h.listings();
  h.timers.get(EXCHANGE_INTERVAL_MS)![0]!();
  await flush();
  assert.equal(h.listings(), before + 1, "the round waits for the held discovery listing");
  const started = Date.now();
  socket.message(deliver(4, CLAUDE_TARGET));
  await flush();
  assert.ok(getMessage(h.paths.inbox, messageId(4)), "stored while the round is pending");
  assert.ok(Date.now() - started < 200, "stored within 200 ms");
  assert.equal(statuses(socket, messageId(4)).length, 1);
  h.release();
  await flush();
  const after = socket.sent.length;
  socket.message(deliver(5, CLAUDE_TARGET));
  await flush();
  assert.equal(statuses(socket, messageId(5)).length, 1, "the round completed and the lanes keep working");
  assert.ok(socket.sent.length > after);
});

test("a Codex-target delivery is stored while the Claude runtime is not ready", async (t) => {
  const h = intakeHarness(t, {
    policy: { version: 1, allowedCommands: [], sessions: { enabled: true, workspaceRoots: [os.tmpdir()], runtimes: ["claude", "codex"] },
      messaging: { accept: [{ from: ["*"], session: "*" }] } },
    probe: async (runtime) => runtime === "claude" ? { ok: false, cause: "sign-in", detail: "synthetic sign-in required" } : { ok: true },
  });
  await flush();
  const socket = h.socket();
  socket.message(AUTH_OK);
  await flush();
  socket.message(deliver(6, CODEX_TARGET));
  await flush();
  assert.equal(getMessage(h.paths.inbox, messageId(6))?.state, "accepted");
  assert.equal(statuses(socket, messageId(6)).length, 1);
  // The startup probes pass the service admission off the lanes; wait for both verdicts.
  for (let i = 0; i < 100 && !(readDaemonState(h.paths)?.readiness?.claude && readDaemonState(h.paths)?.readiness?.codex); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(readDaemonState(h.paths)?.readiness?.claude?.ready, false, "the Claude verdict is recorded");
  assert.equal(readDaemonState(h.paths)?.readiness?.codex?.ready, true);
});

test("a store failure answers nothing and leaves the frame for the next authentication", async (t) => {
  const h = intakeHarness(t);
  await flush();
  const socket = h.socket();
  socket.message(AUTH_OK);
  await flush();
  fs.rmSync(h.paths.inbox, { recursive: true, force: true });
  fs.writeFileSync(h.paths.inbox, "not a directory");
  socket.message(deliver(7, CLAUDE_TARGET));
  await flush();
  assert.equal(socket.sent.some((f) => f.type === "message.status"), false, "no answer: the Worker keeps the message queued");
  assert.equal(h.logs.filter((line) => line.includes(`could not store message ${messageId(7)}`)).length, 1);
});

test("a delivery after a reconnect waits for its authentication while the old socket's slow handler holds the frame lane", async (t) => {
  const h = intakeHarness(t);
  await flush();
  const old = h.socket();
  old.message(AUTH_OK);
  await flush();
  old.message(command(1, "session.list"));
  await flush();
  const fresh = await h.reconnect();
  assert.notEqual(fresh, old);
  fresh.message(AUTH_OK);
  fresh.message(deliver(8, CLAUDE_TARGET));
  await flush();
  assert.equal(getMessage(h.paths.inbox, messageId(8)), null, "not handled before its authentication");
  assert.equal(statuses(fresh, messageId(8)).length, 0, "no answer before auth.ok is processed");
  h.release();
  await flush();
  const accepted = fresh.sent.findIndex((f) => f.type === "message.status" && (f.body as { messageId?: string }).messageId === messageId(8));
  const register = fresh.sent.findIndex((f) => f.type === "register");
  assert.ok(register >= 0 && accepted > register, "acknowledged after the new connection authenticated");
  assert.equal(getMessage(h.paths.inbox, messageId(8))?.state, "accepted", "stored, never dropped");
  assert.equal(statuses(fresh, messageId(8)).length, 1, "acknowledged exactly once");
});

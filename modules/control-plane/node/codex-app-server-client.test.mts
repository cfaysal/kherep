import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { AppServerClient, AppServerRequestError, type AppServerMessage, type AppServerOptions } from "./codex-app-server-client.mts";

// Issue #408, PR 3: the JSON-RPC client extracted from the native Queue client.
// Every case runs on an in-memory child; nothing starts a process.

type Reply = (request: { id?: number; method: string; params?: unknown }, write: (data: string | Buffer) => void) => void;

function fakeChild(reply: Reply, exitOn: { end?: boolean; term?: boolean } = { end: true }) {
  const stdout = new PassThrough(), stderr = new PassThrough(), stdin = new PassThrough();
  const written: Record<string, unknown>[] = [];
  const signals: string[] = [];
  const child = Object.assign(new EventEmitter(), { stdout, stderr, stdin, pid: 4242, killed: false,
    exitCode: null as number | null, signalCode: null as string | null,
    kill(signal?: string) { signals.push(signal ?? "SIGTERM"); return true; } });
  const end = (): void => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = 0;
    setImmediate(() => { child.emit("exit", 0, null); child.emit("close", 0, null); });
  };
  let pending = "";
  stdin.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
      const message = JSON.parse(pending.slice(0, at)) as { id?: number; method: string };
      pending = pending.slice(at + 1);
      written.push(message);
      if (message.method) reply(message, (data) => stdout.write(data));
    }
  });
  stdin.on("finish", () => { if (exitOn.end) end(); });
  const kill = (signal: NodeJS.Signals): void => {
    signals.push(signal);
    if (signal === "SIGKILL" || exitOn.term) end();
  };
  return { child: child as never, written, signals, kill };
}

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;
const client = (fake: ReturnType<typeof fakeChild>, options: Partial<AppServerOptions> = {}) =>
  new AppServerClient(fake.child, { requestTimeoutMs: 200, kill: fake.kill, ...options });

test("notifications reach the listener in order and responses resolve their requests", async () => {
  const fake = fakeChild((request, write) => {
    write(line({ method: "thread/started", params: { n: 1 } }));
    write(line({ method: "thread/status/changed", params: { n: 2 } }));
    write(line({ id: request.id, result: { ok: request.method } }));
  });
  const c = client(fake);
  const notes: AppServerMessage[] = [];
  c.onNotification((note) => notes.push(note));
  assert.deepEqual(await c.request("first", {}), { ok: "first" });
  assert.deepEqual(notes.map((note) => [note.method, note.params]), [["thread/started", { n: 1 }], ["thread/status/changed", { n: 2 }]]);
  assert.equal(await c.shutdown(), true);
});

test("a server request is refused with -32601 and reported, also when its id equals a pending request id", async () => {
  const fake = fakeChild((request, write) => {
    // Same numeric id as the client's pending request, but with a method: a server request.
    write(line({ id: request.id, method: "item/commandExecution/requestApproval", params: { command: "rm -rf /" } }));
    setImmediate(() => write(line({ id: request.id, result: { real: true } })));
  });
  const requests: AppServerMessage[] = [];
  const c = client(fake, { onServerRequest: (message) => requests.push(message) });
  assert.deepEqual(await c.request("turn/start", {}), { real: true }, "only the message without a method answers the request");
  assert.deepEqual(requests.map((r) => r.method), ["item/commandExecution/requestApproval"]);
  assert.deepEqual(fake.written.find((m) => m.error !== undefined),
    { id: 0, error: { code: -32601, message: "kherep fork reply has no approval authority" } });
  await c.shutdown();
});

test("a UTF-8 character split across two stdout chunks decodes exactly", async () => {
  const expected = "grüßen 👋";
  const fake = fakeChild((request, write) => {
    const bytes = Buffer.from(line({ id: request.id, result: { text: expected } }), "utf8");
    // Inside the two-byte ü and inside the four-byte emoji.
    const first = bytes.indexOf(Buffer.from("ü")) + 1, second = bytes.indexOf(Buffer.from("👋")) + 2;
    assert.ok(first > 0 && second > first);
    write(bytes.subarray(0, first));
    write(bytes.subarray(first, second));
    write(bytes.subarray(second));
  });
  const c = client(fake);
  assert.deepEqual(await c.request("thread/read", {}), { text: expected });
  await c.shutdown();
});

test("an error response rejects with the method, the code and a redacted last line only", async () => {
  const fake = fakeChild((request, write) => write(line({ id: request.id,
    error: { code: -32600, message: "first line\ngoals feature is disabled (token sk-live_Secret1)" } })));
  const c = client(fake);
  const error = await c.request("thread/goal/get", {}).catch((e: unknown) => e) as AppServerRequestError;
  assert.ok(error instanceof AppServerRequestError);
  assert.equal(error.message, "Codex app server rejected thread/goal/get");
  assert.equal(error.code, -32600);
  assert.match(error.detail, /^goals feature is disabled/);
  assert.doesNotMatch(error.detail, /sk-live_Secret1/);
  await c.shutdown();
});

test("malformed lines fail a strict client and are skipped otherwise; oversized output and timeouts fail", async (t) => {
  for (const kind of ["strict", "lenient", "oversized", "timeout", "own-timeout"] as const) await t.test(kind, async () => {
    const fake = fakeChild((request, write) => {
      if (kind === "timeout" || kind === "own-timeout") return;
      if (kind === "oversized") return void write("x".repeat(1_100_000));
      write("{not json\n");
      write(line({ id: request.id, result: {} }));
    });
    const c = client(fake, { strict: kind === "strict", requestTimeoutMs: kind === "own-timeout" ? 60_000 : 30 });
    const call = c.request("m", {}, kind === "own-timeout" ? 30 : undefined);
    if (kind === "lenient") assert.deepEqual(await call, {});
    else await assert.rejects(call, { strict: /malformed/, oversized: /large/, timeout: /timed out/, "own-timeout": /timed out/ }[kind]);
    if (kind !== "lenient") await assert.rejects(c.request("again", {}), "a failed client accepts no request");
    assert.equal(await c.shutdown(), true);
  });
});

test("after a failure close always ends with SIGKILL, even when the direct child exited on SIGTERM (issue #432)", async () => {
  const fake = fakeChild(() => {}, { term: true });
  const c = client(fake, { requestTimeoutMs: 20, graceMs: 50, forceAfterFailure: true });
  await assert.rejects(c.request("thread/read", {}), /timed out/);
  assert.equal(await c.shutdown(), true);
  assert.deepEqual(fake.signals, ["SIGTERM", "SIGKILL"], "the group gets SIGKILL although the child already ended");
});

test("a clean close ends stdin and sends no signal; an unconfirmed one reports false", async () => {
  const clean = fakeChild((request, write) => write(line({ id: request.id, result: {} })));
  const c = client(clean, { graceMs: 50, forceAfterFailure: true });
  await c.request("initialize", {});
  assert.equal(await c.shutdown(), true);
  assert.deepEqual(clean.signals, []);
  const stuck = fakeChild(() => {}, { end: false });
  const kill = (signal: NodeJS.Signals): void => { stuck.signals.push(signal); };
  const s = client(stuck, { graceMs: 20, kill });
  assert.equal(await s.shutdown(), false);
  assert.deepEqual(stuck.signals, ["SIGKILL"]);
});

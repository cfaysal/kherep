// Offline helpers for the model catalog process tests: a synthetic JSON-RPC child, an
// injected clock and scripted group probes. No real process, Codex or account is used.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { CatalogReadError, type GroupProbe } from "./model-catalog-process.mts";

// respond: answer requests at all; page: the model/list result; serverRequestOn: the method
// before whose result the server sends one request of its own.
export function fakeServer(respond = true, page?: unknown, serverRequestOn?: string) {
  const child = Object.assign(new EventEmitter(), { pid: 12345, stdin: new PassThrough(), stdout: new PassThrough(),
    stderr: new PassThrough(), exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, killed: false });
  const methods: string[] = [], kills: NodeJS.Signals[] = [];
  child.stdin.on("data", (chunk) => {
    const message = JSON.parse(String(chunk));
    if (typeof message.method === "string") methods.push(message.method);
    if (!respond || message.id === undefined) return;
    const result = message.method === "initialize" ? {} : page ?? { data: [{ id: "gpt-6-sol", model: "gpt-6-sol", hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: "high" }] }], nextCursor: null };
    queueMicrotask(() => {
      if (message.method === serverRequestOn) child.stdout.write(JSON.stringify({ id: "synthetic-server-request", method: "item/tool/call" }) + "\n");
      child.stdout.write(JSON.stringify({ id: message.id, result }) + "\n");
    });
  });
  const stop = () => {
    if (child.signalCode !== null) return;
    child.signalCode = "SIGKILL";
    queueMicrotask(() => { child.emit("exit", null, "SIGKILL"); child.emit("close", null, "SIGKILL"); });
  };
  // Exit on stdin end so POSIX tests skip the client's fixed shutdown grace.
  child.stdin.on("finish", stop);
  return { child: child as unknown as ChildProcessWithoutNullStreams, stop, methods, kills };
}
export type FakeServer = ReturnType<typeof fakeServer>;

// Injected clock: sleep advances time and records each wait.
export function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, sleeps };
}
export type FakeClock = Pick<ReturnType<typeof fakeClock>, "now" | "sleep" | "sleeps">;

// Scripted group probe answers; the last one repeats. Beyond the budget it throws, so a
// loop that is not bounded fails fast instead of hanging the suite.
export function probes(...states: GroupProbe[]) {
  const seen: GroupProbe[] = [], budget = 200;
  return { seen, probeGroup(pid: number) {
    assert.equal(pid, 12345);
    if (seen.length >= budget) throw new Error("synthetic-budget-guard");
    const state = states[Math.min(seen.length, states.length - 1)];
    seen.push(state);
    return state;
  } };
}
export type Probes = ReturnType<typeof probes>;

// POSIX options around a fake server; every group signal is recorded in server.kills.
export function posix(server: FakeServer, probe: Probes, clock: FakeClock = fakeClock()) {
  return { executable: "synthetic-codex", platform: "linux" as const, spawn() { return server.child; },
    killGroup(pid: number, signal: NodeJS.Signals) { assert.equal(pid, 12345); server.kills.push(signal); server.stop(); return "sent" as const; },
    probeGroup: probe.probeGroup, now: clock.now, sleep: clock.sleep };
}

// Ownership timeline (independent review, H1): each step is the probe's answer and, optionally,
// who holds the group number once that probe callback returns ("foreign": a reused pgid, "none":
// no group). killGroup records whose group a signal reached. The script is finite: a probe past
// its end throws, so an unbounded loop fails fast. Only the owned close may ever signal.
export type GroupOwner = "owned" | "foreign" | "none";
export function timeline(server: FakeServer, clock: FakeClock, ...steps: Array<[GroupProbe, GroupOwner?]>) {
  let owner: GroupOwner = "owned";
  const seen: GroupProbe[] = [], signals: GroupOwner[] = [];
  const probe: Probes = { seen, probeGroup(pid: number) {
    assert.equal(pid, 12345);
    const step = steps[seen.length];
    if (!step) throw new Error("synthetic-budget-guard");
    seen.push(step[0]);
    if (step[1]) owner = step[1];
    return step[0];
  } };
  const options = posix(server, probe, clock);
  return { ...options, seen, signals, killGroup(pid: number, signal: NodeJS.Signals) { signals.push(owner); return options.killGroup(pid, signal); } };
}

export const BASE = "Codex model catalog unavailable or cleanup unconfirmed";
export function staged(stage: string, cleanupConfirmed: boolean, message: string) {
  return (error: unknown) => {
    assert.ok(error instanceof CatalogReadError);
    assert.equal(error.stage, stage);
    assert.equal(error.cleanupConfirmed, cleanupConfirmed);
    assert.equal(error.message, message);
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(JSON.stringify(error) + error.message, /synthetic|nope/);
    return true;
  };
}

// One transport fault on the fake stdin: the write carrying `method` throws, or emits a synchronous
// 'error' event and returns false (the two ways a Writable can fail a write before it returns).
// Returns every attempted method, also the ones that never reached the fake server.
export function writeFault(server: FakeServer, method: string, mode: "throw" | "error-event"): string[] {
  const attempted: string[] = [], stdin = server.child.stdin, write = stdin.write.bind(stdin);
  stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
    const name = JSON.parse(String(chunk)).method as string;
    attempted.push(name);
    if (name !== method) return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
    const error = new Error("synthetic-transport");
    if (mode === "throw") throw error;
    stdin.emit("error", error);
    return false;
  }) as typeof stdin.write;
  return attempted;
}

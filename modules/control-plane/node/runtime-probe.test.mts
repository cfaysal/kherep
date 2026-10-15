import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { forgetCodexSession, isCodexSession, recordCodexSession } from "./codex-sessions.mts";
import { nodePaths } from "./config.mts";
import { pidAlive } from "./daemon-state.mts";
import { CLAUDE_PROBE_ARGS, probeRuntime, spawnProbe, type ProbeRun, type ProbeSpawnOptions } from "./runtime-probe.mts";
import { retainServiceAdmission, serviceAdmissionsIdle, withServiceAdmission } from "./service-drain.mts";
import { testServiceOwner } from "./task-fixture.mts";

// Issue #197: the readiness probe is a real minimal call. These tests replace
// the process with a recorded fake; spawnProbe's timeout runs a real process.

const posix = { skip: process.platform === "win32" ? "POSIX process group kill" : false };

interface Recorded { file: string; args: string[]; options: ProbeSpawnOptions }
function fake(result: Partial<ProbeRun>) {
  const calls: Recorded[] = [];
  const run = async (file: string, args: string[], options: ProbeSpawnOptions): Promise<ProbeRun> => {
    calls.push({ file, args, options });
    return { code: 0, stdout: "", stderr: "", timedOut: false, ...result };
  };
  return { calls, run };
}
const claudeDeps = (run: ReturnType<typeof fake>["run"]) => ({ findClaude: () => "/opt/bin/claude", platform: "linux" as const, run, cwd: "/tmp/probe" });
const codexDeps = (run: ReturnType<typeof fake>["run"], forgotten: string[] = []) => ({ findCodex: () => "/opt/bin/codex",
  platform: "linux" as const, run, cwd: "/tmp/probe", mcpOverrides: async () => ["-c", "mcp_servers.docs.enabled=false"],
  forgetSession: (thread: string) => { forgotten.push(thread); } });
const result = (isError: boolean, text: string): string =>
  `${JSON.stringify({ type: "result", subtype: isError ? "error" : "success", is_error: isError, result: text })}\n`;

test("a Claude probe is one print-mode turn without customizations, tools or a saved session, ready on a successful result", async () => {
  const f = fake({ stdout: result(false, "OK") });
  assert.deepEqual(await probeRuntime("claude", claudeDeps(f.run)), { ok: true });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].file, "/opt/bin/claude");
  assert.deepEqual(f.calls[0].args, [...CLAUDE_PROBE_ARGS]);
  for (const flag of ["-p", "--safe-mode", "--no-session-persistence", "--strict-mcp-config"]) assert.ok(f.calls[0].args.includes(flag), flag);
  assert.equal(f.calls[0].args[f.calls[0].args.indexOf("--tools") + 1], "", "no tools");
  assert.equal(f.calls[0].options.cwd, "/tmp/probe");
});

test("an expired Claude login is not ready with cause sign-in, even though auth status would say logged in", async () => {
  const f = fake({ code: 1, stdout: result(true, "Failed to authenticate: OAuth session expired and could not be refreshed") });
  assert.deepEqual(await probeRuntime("claude", claudeDeps(f.run)),
    { ok: false, cause: "sign-in", detail: "Failed to authenticate: OAuth session expired and could not be refreshed" });
  const zero = fake({ code: 0, stdout: result(true, "Not logged in · Please run /login") });
  assert.equal((await probeRuntime("claude", claudeDeps(zero.run))).ok, false, "exit 0 with an error result is not ready");
  const other = fake({ code: 1, stderr: "API Error: 529 overloaded" });
  assert.deepEqual(await probeRuntime("claude", claudeDeps(other.run)), { ok: false, cause: "error", detail: "API Error: 529 overloaded" });
});

test("a probe that times out is not ready with cause timeout; a missing CLI is an error", async () => {
  const f = fake({ code: null, timedOut: true });
  assert.deepEqual(await probeRuntime("claude", claudeDeps(f.run)), { ok: false, cause: "timeout", detail: "" });
  assert.deepEqual(await probeRuntime("codex", codexDeps(f.run)), { ok: false, cause: "timeout", detail: "" });
  assert.deepEqual(await probeRuntime("claude", { ...claudeDeps(f.run), findClaude: () => null }),
    { ok: false, cause: "error", detail: "claude is not installed on this node" });
});

test("a Codex probe is an ephemeral read-only exec with the user config but no hooks or MCP servers, its prompt on stdin, ready after turn.completed", async () => {
  const thread = "0199a000-0000-7000-8000-0000000000f1";
  const events = [{ type: "thread.started", thread_id: thread }, { type: "turn.started" }, { type: "item.completed" }, { type: "turn.completed" }];
  const f = fake({ stdout: events.map((e) => JSON.stringify(e)).join("\n") });
  const forgotten: string[] = [];
  assert.deepEqual(await probeRuntime("codex", codexDeps(f.run, forgotten)), { ok: true });
  assert.deepEqual(f.calls[0].args, ["-c", "features.hooks=false", "-c", "features.codex_hooks=false", "-c", "mcp_servers.docs.enabled=false",
    "exec", "--json", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "-C", "/tmp/probe", "-"]);
  assert.ok(!f.calls[0].args.includes("--ignore-user-config"), "the same config as a real run");
  assert.deepEqual(forgotten, [thread], "the session record a delivery hook wrote for the probe is removed");
  assert.equal(f.calls[0].options.input, "Reply with OK.");
  const exit0 = fake({ stdout: JSON.stringify({ type: "turn.started" }) });
  assert.equal((await probeRuntime("codex", codexDeps(exit0.run))).ok, false, "exit 0 without turn.completed is not ready");
});

test("a Codex probe that times out still forgets the session a hook recorded for its thread", async () => {
  const thread = "0199a000-0000-7000-8000-0000000000f3";
  const started = JSON.stringify({ type: "thread.started", thread_id: thread });
  const f = fake({ code: null, timedOut: true, stdout: `${started}\n{"type":"turn.st` });
  const forgotten: string[] = [];
  assert.deepEqual(await probeRuntime("codex", codexDeps(f.run, forgotten)), { ok: false, cause: "timeout", detail: "" });
  assert.deepEqual(forgotten, [thread]);
  const failed = fake({ code: 1, stdout: `${started}\n${JSON.stringify({ type: "error", message: "boom" })}` });
  const again: string[] = [];
  assert.equal((await probeRuntime("codex", codexDeps(failed.run, again))).ok, false);
  assert.deepEqual(again, [thread], "also after an error");
});

test("a Codex 401 is sign-in; the detail is one redacted line, never a token", async () => {
  const failed = { type: "turn.failed", error: { message: "unexpected status 401 Unauthorized: Bearer eyJabc.def.ghi rejected" } };
  const f = fake({ code: 1, stdout: JSON.stringify(failed) });
  const verdict = await probeRuntime("codex", codexDeps(f.run));
  assert.equal(verdict.ok, false);
  assert.ok(!verdict.ok && verdict.cause === "sign-in");
  assert.ok(!verdict.ok && !verdict.detail.includes("eyJabc"), "redacted");
  const usage = fake({ code: 1, stdout: JSON.stringify({ type: "error", message: "You've hit your usage limit" }) });
  assert.deepEqual(await probeRuntime("codex", codexDeps(usage.run)), { ok: false, cause: "error", detail: "You've hit your usage limit" });
});

test("spawnProbe kills a process that outlives the timeout and reports timedOut", posix, async () => {
  const started = Date.now();
  const out = await spawnProbe()(process.execPath, ["-e", "process.stdout.write('x'); setTimeout(() => {}, 30000)"], { cwd: process.cwd(), timeoutMs: 300 });
  assert.equal(out.timedOut, true);
  assert.ok(Date.now() - started < 10_000, "killed, not waited for");
  const ok = await spawnProbe()(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { cwd: process.cwd(), timeoutMs: 10_000, input: "hi" });
  assert.deepEqual(ok, { code: 0, stdout: "hi", stderr: "", timedOut: false });
});

test("an unconfirmed started readiness helper retains its service admission", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-probe-admission-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  const child = Object.assign(new EventEmitter(), {
    pid: 4567, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    exitCode: null, signalCode: null,
  });
  const out = await withServiceAdmission(paths, (admission) => spawnProbe("win32", (() => child) as never)(
    "synthetic-probe", [], { cwd: root, timeoutMs: 5, signal: () => {},
      onUnconfirmedShutdown: () => retainServiceAdmission(admission) }), testServiceOwner);
  assert.equal(out.timedOut, true);
  assert.equal(serviceAdmissionsIdle(paths, testServiceOwner), false, "unknown helper lifetime blocks service mutation after the probe returns");
});

test("forgetCodexSession removes exactly the probe's recorded session", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-probe-forget-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  const probe = "0199a000-0000-7000-8000-0000000000f1";
  const other = "0199a000-0000-7000-8000-0000000000f2";
  for (const id of [probe, other]) recordCodexSession(paths, id, "/tmp");
  forgetCodexSession(paths, probe);
  forgetCodexSession(paths, "../not-a-session");
  assert.deepEqual([isCodexSession(paths, probe), isCodexSession(paths, other)], [false, true]);
});

// Issue #420: a timed-out Claude probe may be waiting on a login renewal, so on
// POSIX its group gets SIGTERM and SIGKILL only after a grace. Windows has no
// graceful signal for a windowless console process: taskkill /T /F at once.
// The direct child's exit and close prove nothing about the rest of its
// process group, so the group SIGKILL follows the grace in any case.
function fakeChild(platform: NodeJS.Platform, endOn: NodeJS.Signals | null) {
  const child = Object.assign(new EventEmitter(), {
    pid: 4567, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), exitCode: null, signalCode: null,
  });
  const sent: NodeJS.Signals[] = [];
  const signal = (_pid: number, value: NodeJS.Signals) => {
    sent.push(value);
    if (value === endOn || value === "SIGKILL") setImmediate(() => { child.emit("exit", null, value); child.emit("close", null, value); });
  };
  const run = (graceMs: number) => spawnProbe(platform, (() => child) as never)("synthetic-probe", [],
    { cwd: os.tmpdir(), timeoutMs: 5, graceMs, signal });
  return { run, sent };
}

test("a timed-out POSIX probe gets SIGTERM first and the group SIGKILL after the grace", async () => {
  const stubborn = fakeChild("linux", null);
  const started = Date.now();
  assert.equal((await stubborn.run(100)).timedOut, true);
  assert.deepEqual(stubborn.sent, ["SIGTERM", "SIGKILL"]);
  assert.ok(Date.now() - started >= 90, "SIGKILL waited for the grace");
});

test("a POSIX probe whose launcher ends on SIGTERM settles only after the group SIGKILL at the end of the grace", async () => {
  const launcher = fakeChild("linux", "SIGTERM");
  const started = Date.now();
  let settledAt = 0;
  const pending = launcher.run(300).then((out) => { settledAt = Date.now(); return out; });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(launcher.sent, ["SIGTERM"], "the launcher has exited and closed");
  assert.equal(settledAt, 0, "not settled before the grace ran out");
  assert.equal((await pending).timedOut, true);
  assert.deepEqual(launcher.sent, ["SIGTERM", "SIGKILL"], "a helper left in the group still gets SIGKILL");
  assert.ok(settledAt - started >= 290, "settled after the grace");
});

test("a timed-out Windows probe is still killed with its tree at once", async () => {
  const windows = fakeChild("win32", null);
  assert.equal((await windows.run(5_000)).timedOut, true);
  assert.deepEqual(windows.sent, ["SIGKILL"]);
});

test("a real POSIX probe gets the full grace whether it ends on SIGTERM or ignores it", posix, async () => {
  let started = Date.now();
  const polite = await spawnProbe()(process.execPath, ["-e", "setTimeout(() => {}, 30000)"],
    { cwd: process.cwd(), timeoutMs: 200, graceMs: 1_000 });
  assert.equal(polite.timedOut, true);
  assert.ok(Date.now() - started >= 1_100, "settled only after the grace");
  started = Date.now();
  const stubborn = await spawnProbe()(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    { cwd: process.cwd(), timeoutMs: 200, graceMs: 1_000 });
  assert.equal(stubborn.timedOut, true);
  assert.ok(Date.now() - started >= 1_100, "SIGKILL only after the grace");
});

test("a real POSIX helper that traps SIGTERM in the probe's group is dead after the probe settles", posix, async () => {
  const helper = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
  const launcher = [
    `const h = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], { stdio: 'ignore' });`,
    "h.unref(); process.stdout.write(String(h.pid)); setInterval(() => {}, 1000);"].join(" ");
  const out = await spawnProbe()(process.execPath, ["-e", launcher], { cwd: process.cwd(), timeoutMs: 500, graceMs: 500 });
  assert.equal(out.timedOut, true);
  const helperPid = Number(out.stdout.trim());
  assert.ok(Number.isInteger(helperPid) && helperPid > 0, out.stdout);
  const deadline = Date.now() + 2_000;
  while (pidAlive(helperPid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(pidAlive(helperPid), false, "the group SIGKILL reached the helper");
});

// The libuv job object (src/win/process.c: every child not spawned detached is
// assigned to a job that kills it when the parent exits) measured on this host:
// a daemon killed by TerminateProcess takes its non-detached Claude child along.
const windows = { skip: process.platform !== "win32" && "Windows job object" };
test("on Windows a killed parent takes its non-detached child along", windows, async () => {
  const parent = spawn(process.execPath, ["-e", [
    "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });",
    "console.log(c.pid); setTimeout(() => {}, 60000);"].join(" ")], { stdio: ["ignore", "pipe", "ignore"] });
  const childPid = Number(await new Promise<string>((resolve) => {
    parent.stdout.once("data", (chunk: Buffer) => resolve(String(chunk)));
  }));
  assert.ok(pidAlive(childPid), "the child runs");
  parent.kill();
  const deadline = Date.now() + 2_000;
  while (pidAlive(childPid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(pidAlive(childPid), false, "the child ended with its parent");
});

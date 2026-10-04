import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { forgetCodexSession, isCodexSession, recordCodexSession } from "./codex-sessions.mts";
import { nodePaths } from "./config.mts";
import { CLAUDE_PROBE_ARGS, probeRuntime, spawnProbe, type ProbeRun, type ProbeSpawnOptions } from "./runtime-probe.mts";

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

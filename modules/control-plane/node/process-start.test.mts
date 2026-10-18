import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ChildRun } from "./child-run.mts";
import { waitFor } from "./codex-fixture.mts";
import { spawnCodex } from "./codex-process.mts";
import { processStart } from "./process-start.mts";

// Issue #473: the start-time read runs as an awaited child process, so the
// daemon's event loop keeps reading socket frames while PowerShell starts.
// The fakes stand in for the child; process.pid passes the POSIX liveness probe.

const after = (ms: number, settle: () => void): void => { setTimeout(settle, ms); };

test("a pending start-time read does not block the event loop", async () => {
  const order: string[] = [];
  const slow: ChildRun = () => new Promise((resolve) => after(150, () => { order.push("read"); resolve("133700000000\n"); }));
  after(1, () => order.push("timer"));
  assert.equal(await processStart(process.pid, process.platform, slow), "133700000000");
  assert.deepEqual(order, ["timer", "read"]);
});

test("empty output is no such process; a failed or timed-out read throws, never null", async () => {
  assert.equal(await processStart(process.pid, process.platform, async () => ""), null);
  const failed = Object.assign(new Error("Command failed: synthetic"), { code: 1 });
  await assert.rejects(processStart(process.pid, process.platform, async () => { throw failed; }), failed);
  const timedOut = Object.assign(new Error("powershell.exe timed out after 10 s"), { code: "ETIMEDOUT" });
  await assert.rejects(processStart(process.pid, process.platform, async () => { throw timedOut; }), { code: "ETIMEDOUT" });
});

test("Windows reads the start time with the same PowerShell command and a 10 s limit", async () => {
  const calls: [string, string[], number][] = [];
  const run: ChildRun = async (file, args, options) => { calls.push([file, args, options.timeoutMs]); return "42\r\n"; };
  assert.equal(await processStart(4242, "win32", run), "42");
  assert.deepEqual(calls, [["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "try { (Get-Process -Id 4242 -ErrorAction Stop).StartTime.ToFileTimeUtc() } "
    + "catch [Microsoft.PowerShell.Commands.ProcessCommandException] { exit 0 }"], 10_000]]);
});

// A run must not end before its start time is read: codex gets the end of its
// prompt only after the read, as while the read blocked the event loop.
test("a started run's start time is read before it gets the end of its prompt", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-start-read-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const files = { dir, events: path.join(dir, "events.jsonl"), lastMessage: path.join(dir, "last.txt"),
    stderr: path.join(dir, "stderr.log"), exit: path.join(dir, "exit.json") };
  let alive = false;
  const processStart = async (pid: number): Promise<string> => {
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      // ended: its prompt reached it before the read
    }
    return "synthetic-start";
  };
  const reader = "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));";
  const run = await spawnCodex({ processStart }, process.execPath, ["-e", reader], dir, files, process.env, "synthetic prompt", false);
  assert.equal(run.pidStart, "synthetic-start");
  assert.equal(alive, true, "still waiting for its prompt while the start time was read");
  await waitFor(() => fs.existsSync(files.exit), "the run's exit");
});

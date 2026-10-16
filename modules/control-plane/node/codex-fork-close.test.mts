import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { waitFor } from "./codex-fixture.mts";
import { PRODUCER, runFork } from "./codex-fork-run-fixture.mts";
import { signalGroupReport } from "./codex-process.mts";

// Issue #408, PR 3: the close of a real helper process. A synthetic Node script
// stands in for `codex app-server` (no Codex runs): it answers initialize, then
// ignores stdin end and SIGTERM and keeps a grandchild in its process group,
// so only the SIGKILL of the group (POSIX) or of the tree (Windows) ends both.

const SCRIPT = (log: string): string => `
const fs = require("node:fs");
process.on("SIGTERM", () => {});
const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, child: child.pid, cwd: process.cwd(),
  fork: process.env.KHEREP_CODEX_FORK, args: process.argv.slice(2) }));
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf("\\n"); at >= 0; at = buffer.indexOf("\\n")) {
    const request = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    if (request.method === "initialize") process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
  }
});
process.stdin.on("end", () => {});
setInterval(() => {}, 1000);
`;

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

test("a helper that ignores stdin end and SIGTERM is ended with its group, and the attempt fails", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-fork-close-"));
  const log = path.join(dir, "helper.json"), script = path.join(dir, "helper.js");
  fs.writeFileSync(script, SCRIPT(log));
  t.after(() => {
    try {
      const { pid, child } = JSON.parse(fs.readFileSync(log, "utf8")) as { pid: number; child: number };
      for (const id of [pid, child]) if (alive(id)) process.kill(id, "SIGKILL");
    } catch { /* never started */ }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const r = await runFork(t, {}, { producer: { ...PRODUCER, launchFile: process.execPath, launchPrefix: [script] },
    timeouts: { initializeMs: 5_000, requestMs: 300, graceMs: 250 } }, { spawn: undefined, killGroup: undefined, platform: process.platform });
  assert.deepEqual(r.outcome, { state: "failed", from: "launching", reason: "cwd-mismatch" }, "thread/read timed out");
  const helper = JSON.parse(fs.readFileSync(log, "utf8")) as { pid: number; child: number; cwd: string; fork: string; args: string[] };
  assert.deepEqual([fs.realpathSync.native(helper.cwd), helper.fork, helper.args], [r.cwd, "1", ["app-server", "--listen", "stdio://"]]);
  await waitFor(() => !alive(helper.pid) && !alive(helper.child), "the helper and its grandchild to end");
  assert.equal(r.unconfirmed(), 0, "exit and close confirmed");
});

// Failed-kill follow-up of #439: the real OS report for a root that has exited. POSIX kill(-pgid) answers ESRCH
// (the group is absent); Windows taskkill /T cannot address an exited root, so its failure is unconfirmed. On
// Windows a PowerShell holder keeps a handle to the root, so its PID cannot be reused by a foreign process
// before taskkill runs (measured: taskkill still answers "not found", exit 128).
test("signalGroupReport on an exited root answers absent on POSIX and unconfirmed on Windows", async () => {
  const win32 = process.platform === "win32";
  const root = spawn(process.execPath, ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))"],
    { stdio: ["pipe", "ignore", "ignore"], detached: !win32, windowsHide: true });
  const holder = win32 ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$p = [System.Diagnostics.Process]::GetProcessById(${root.pid}); `
    + "$null = $p.Handle; [Console]::Out.WriteLine('held'); $null = [Console]::In.ReadLine()"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true }) : null;
  const holderClosed = holder ? new Promise((resolve) => holder.once("close", resolve)) : null;
  try {
    if (holder) await new Promise((resolve, reject) => {
      holder.stdout.once("data", resolve);
      holder.once("error", reject);
      void holderClosed!.then(() => reject(new Error("the handle holder ended before it held the root")));
    });
    const closed = new Promise((resolve) => root.once("close", resolve));
    root.stdin.end();
    await closed;
    assert.equal(signalGroupReport(root.pid!, "SIGKILL", process.platform), win32 ? "unconfirmed" : "absent");
  } finally {
    if (root.exitCode === null && root.signalCode === null) root.kill("SIGKILL");
    if (holder) { holder.stdin.end(); await holderClosed; }
  }
});

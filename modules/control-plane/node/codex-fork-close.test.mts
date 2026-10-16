import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { waitFor } from "./codex-fixture.mts";
import { PRODUCER, runFork } from "./codex-fork-run-fixture.mts";

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
    timeouts: { initializeMs: 5_000, requestMs: 300, graceMs: 250 } }, { spawn: undefined, signal: undefined, platform: process.platform });
  assert.deepEqual(r.outcome, { state: "failed", from: "launching", reason: "cwd-mismatch" }, "thread/read timed out");
  const helper = JSON.parse(fs.readFileSync(log, "utf8")) as { pid: number; child: number; cwd: string; fork: string; args: string[] };
  assert.deepEqual([fs.realpathSync.native(helper.cwd), helper.fork, helper.args], [r.cwd, "1", ["app-server", "--listen", "stdio://"]]);
  await waitFor(() => !alive(helper.pid) && !alive(helper.child), "the helper and its grandchild to end");
  assert.equal(r.unconfirmed(), 0, "exit and close confirmed");
});

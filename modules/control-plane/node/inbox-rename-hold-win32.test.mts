import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test, { type TestContext } from "node:test";

import { RENAME_RETRY_DELAYS_MS, writeJsonAtomic } from "./inbox.mts";

// Issue #540, measured on a real Windows host: another process holds the
// rename target open while writeJsonAtomic replaces it.
const SUM = RENAME_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
const PREVIOUS = "previous\n";
const windows = { skip: process.platform !== "win32" };

// A target with old content and a holder that opens it, writes the gate file
// and closes it after holdMs. Waits for the gate; the holder is killed in
// t.after (also when its gate never appears) before the directory is removed.
async function held(t: TestContext, holder: "powershell" | "node", holdMs: number): Promise<{ dir: string; file: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-rename-hold-"));
  const file = path.join(dir, "daemon.json");
  const gate = path.join(dir, "gate");
  fs.writeFileSync(file, PREVIOUS);
  const child: ChildProcess = holder === "powershell"
    ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$f = [System.IO.File]::Open($env:HOLD_FILE, 'Open', 'Read', 'Read'); "
      + "[System.IO.File]::WriteAllText($env:HOLD_GATE, ''); Start-Sleep -Milliseconds $env:HOLD_MS; $f.Close()"],
    { stdio: "ignore", env: { ...process.env, HOLD_FILE: file, HOLD_GATE: gate, HOLD_MS: String(holdMs) } })
    : spawn(process.execPath, ["-e", "const fs=require('node:fs');const fd=fs.openSync(process.argv[1],'r');"
      + "fs.writeFileSync(process.argv[2],'');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Number(process.argv[3]));"
      + "fs.closeSync(fd);process.exit(0)", file, gate, String(holdMs)], { stdio: "ignore" });
  const exited = new Promise<void>((resolve) => { child.once("exit", () => resolve()); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const deadline = Date.now() + 30_000;
  while (!fs.existsSync(gate)) {
    if (child.exitCode !== null) throw new Error(`the ${holder} holder exited (${child.exitCode}) before its gate`);
    if (Date.now() > deadline) throw new Error(`the ${holder} holder gate never appeared`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { dir, file };
}

function timed(action: () => void): number {
  const start = performance.now();
  action();
  return performance.now() - start;
}

test("a write succeeds within the budget while PowerShell holds the target for 200 ms", windows, async (t) => {
  const { dir, file } = await held(t, "powershell", 200);
  const elapsed = timed(() => writeJsonAtomic(file, { a: 1 }));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { a: 1 });
  assert.ok(elapsed < SUM + 2000, `elapsed ${elapsed} ms`);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["daemon.json", "gate"]);
});

test("a hold longer than the budget fails the write with the original error after the bound", windows, async (t) => {
  const { dir, file } = await held(t, "powershell", 6000);
  const elapsed = timed(() => assert.throws(() => writeJsonAtomic(file, { a: 1 }),
    (error: NodeJS.ErrnoException) => ["EPERM", "EBUSY"].includes(error.code ?? "")));
  assert.ok(SUM <= elapsed && elapsed < SUM + 2000, `elapsed ${elapsed} ms`);
  assert.equal(fs.readFileSync(file, "utf8"), PREVIOUS);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["daemon.json", "gate"]);
});

// Whether a Node reader's handle (libuv shares delete) blocks the replace is
// UNKNOWN from the documentation; the attempt count is reported, not asserted.
test("a write succeeds within the budget while a Node process holds the target for 200 ms", windows, async (t) => {
  const { dir, file } = await held(t, "node", 200);
  const real = fs.renameSync;
  let attempts = 0;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => { attempts++; return real(from, to); });
  const elapsed = timed(() => writeJsonAtomic(file, { a: 1 }));
  t.diagnostic(`rename attempts while a Node process held the target: ${attempts}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { a: 1 });
  assert.ok(elapsed < SUM + 2000, `elapsed ${elapsed} ms`);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["daemon.json", "gate"]);
});

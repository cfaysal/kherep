import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import { test } from "node:test";
import { readAvailableModels } from "./model-catalog-process.mts";

function fakeServer(respond = true) {
  const child = Object.assign(new EventEmitter(), { pid: 12345, stdin: new PassThrough(), stdout: new PassThrough(),
    stderr: new PassThrough(), exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, killed: false });
  child.stdin.on("data", (chunk) => {
    if (!respond) return;
    const message = JSON.parse(String(chunk));
    if (message.id === undefined) return;
    const result = message.method === "initialize" ? {} : { data: [{ id: "gpt-6-sol", model: "gpt-6-sol", hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: "high" }] }], nextCursor: null };
    queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id, result }) + "\n"));
  });
  const stop = () => {
    child.signalCode = "SIGKILL";
    queueMicrotask(() => { child.emit("exit", null, "SIGKILL"); child.emit("close", null, "SIGKILL"); });
  };
  return { child: child as unknown as ChildProcessWithoutNullStreams, stop };
}

test("Windows catalog uses owned tree stop and measures disappearance without a real process call", async () => {
  const server = fakeServer();
  let reads = 0, signals = 0;
  let spawnOptions: SpawnOptions | undefined;
  const result = await readAvailableModels({ executable: "synthetic-codex.exe", platform: "win32", codexHome: "synthetic-home",
    spawn(_file, _args, options) { spawnOptions = options; return server.child; },
    killGroup(pid) { assert.equal(pid, 12345); signals++; server.stop(); return "sent"; },
    async relations() { return reads++ === 0 ? [{ pid: 12345, ppid: 1 }, { pid: 12346, ppid: 12345 }] : []; } });
  assert.equal(result.complete, true);
  assert.equal(signals, 1);
  assert.equal(reads, 2);
  assert.equal(spawnOptions?.env?.CODEX_HOME, "synthetic-home");
  assert.equal(spawnOptions?.shell, undefined);
});

test("Windows snapshot cannot authorize signalling an exited or reused child PID", async () => {
  const server = fakeServer();
  let signals = 0;
  await assert.rejects(readAvailableModels({ executable: "synthetic-codex.exe", platform: "win32",
    spawn() { return server.child; }, killGroup() { signals++; return "sent"; },
    async relations() { server.stop(); await Promise.resolve(); return []; } }), /cleanup unconfirmed/);
  assert.equal(signals, 0);
});

test("Windows snapshot failure cleans the owned helper and redacts its error", async () => {
  const server = fakeServer();
  let signals = 0;
  await assert.rejects(readAvailableModels({ executable: "synthetic-codex.exe", platform: "win32",
    spawn() { return server.child; }, killGroup() { signals++; server.stop(); return "sent"; },
    async relations() { throw new Error("synthetic-sensitive-snapshot-error"); } }), (error: Error) => {
      assert.equal(error.message, "Codex model catalog unavailable or cleanup unconfirmed");
      assert.equal(error.cause, undefined);
      return true;
    });
  assert.equal(signals, 1);
});

test("Windows cleanup rejects surviving tracked children after a successful tree signal", async () => {
  const server = fakeServer();
  let reads = 0;
  await assert.rejects(readAvailableModels({ executable: "synthetic-codex.exe", platform: "win32",
    spawn() { return server.child; }, killGroup() { server.stop(); return "sent"; },
    async relations() { return reads++ === 0 ? [{ pid: 12346, ppid: 12345 }] : [{ pid: 12346, ppid: 1 }]; } }), /cleanup unconfirmed/);
  assert.equal(reads, 2);
});

test("Windows timeout signals only the owned synthetic helper and returns a bounded failure", async () => {
  const server = fakeServer(false);
  const signals: NodeJS.Signals[] = [];
  await assert.rejects(readAvailableModels({ executable: "synthetic-codex.exe", platform: "win32", timeoutMs: 25,
    spawn() { return server.child; }, killGroup(pid, signal) { assert.equal(pid, 12345); signals.push(signal); server.stop(); return "sent"; },
    async relations() { return []; } }), /model catalog unavailable/);
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("metadata app-server closes its exact owned process group after catalog success", { skip: process.platform === "win32" }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-model-server-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const script = path.join(root, "server.mjs");
  fs.writeFileSync(script, `import readline from 'node:readline';
  const entry = {id:'gpt-6-sol',model:'gpt-6-sol',hidden:false,supportedReasoningEfforts:[{reasoningEffort:'high'}]};
  readline.createInterface({input:process.stdin}).on('line', line=>{ const m=JSON.parse(line);
    if(m.id !== undefined) process.stdout.write(JSON.stringify({id:m.id,result:m.method==='initialize'?{}:{data:[entry],nextCursor:null}})+'\\n'); });`);
  let pid: number | undefined;
  const result = await readAvailableModels({ executable: process.execPath, launchPrefix: [script],
    codexHome: path.join(root, "home"), opened(child) { pid = child.pid; } });
  assert.equal(result.models[0].model, "gpt-6-sol");
  assert.ok(pid);
  assert.throws(() => process.kill(-pid!, 0), { code: "ESRCH" });
});

test("metadata deadline kills the owned server without any real Codex or auth call", { skip: process.platform === "win32" }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-model-timeout-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const script = path.join(root, "server.mjs");
  fs.writeFileSync(script, "process.stdin.resume(); setInterval(()=>{},1000);");
  let pid: number | undefined;
  await assert.rejects(readAvailableModels({ executable: process.execPath, launchPrefix: [script],
    timeoutMs: 100, opened(child) { pid = child.pid; } }), /model catalog unavailable/);
  assert.ok(pid);
  assert.throws(() => process.kill(-pid!, 0), { code: "ESRCH" });
});

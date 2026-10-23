import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SpawnOptions } from "node:child_process";
import { test } from "node:test";
import { CatalogReadError, readAvailableModels } from "./model-catalog-process.mts";
import { BASE, fakeClock, fakeServer, posix, probes, staged, writeFault } from "./model-catalog-process.fixture.mts";

test("POSIX cleanup re-asks a transient EPERM until ESRCH and accepts the catalog", async () => {
  const probe = probes("denied", "denied", "absent"), clock = fakeClock(), server = fakeServer();
  const result = await readAvailableModels(posix(server, probe, clock));
  assert.equal(result.complete, true);
  assert.deepEqual(probe.seen, ["denied", "denied", "absent"]);
  assert.deepEqual(clock.sleeps, [25, 25]);
  assert.deepEqual(server.kills, ["SIGKILL"]);
});

test("POSIX cleanup fails closed when EPERM persists to the deadline", async () => {
  const probe = probes("denied"), clock = fakeClock(), server = fakeServer();
  await assert.rejects(readAvailableModels({ ...posix(server, probe, clock), cleanupGraceMs: 100 }),
    staged("cleanup", false, `${BASE} (stage: cleanup)`));
  assert.equal(probe.seen.length, 5);
  assert.deepEqual(clock.sleeps, [25, 25, 25, 25]);
  assert.deepEqual(server.kills, ["SIGKILL"]);
});

test("POSIX cleanup confirmed by an immediate ESRCH costs one probe and no wait", async () => {
  const probe = probes("absent"), clock = fakeClock(), server = fakeServer();
  assert.equal((await readAvailableModels(posix(server, probe, clock))).complete, true);
  assert.equal(probe.seen.length, 1);
  assert.deepEqual(clock.sleeps, []);
  assert.deepEqual(server.kills, ["SIGKILL"]);
});

test("an unanswered initialize reports the start stage", async () => {
  await assert.rejects(readAvailableModels({ ...posix(fakeServer(false), probes("absent")), timeoutMs: 25 }),
    staged("start", true, `${BASE} (stage: start)`));
});

test("a start failure keeps the first stage and carries an unconfirmed cleanup", async () => {
  await assert.rejects(readAvailableModels({ ...posix(fakeServer(false), probes("present")), timeoutMs: 25 }),
    staged("start", false, `${BASE} (stage: start; cleanup unconfirmed)`));
});

test("a malformed model/list page reports the catalog stage", async () => {
  await assert.rejects(readAvailableModels(posix(fakeServer(true, { data: "nope" }), probes("absent"))),
    staged("catalog", true, `${BASE} (stage: catalog)`));
});

// PR #673 review P2: the shared client stores a notification's transport failure instead of throwing,
// so a failed initialized must still be reported as the start stage, never as the catalog stage.
for (const mode of ["throw", "error-event"] as const) {
  test(`an initialized transport ${mode} is a start failure with confirmed cleanup`, async () => {
    const server = fakeServer(), attempted = writeFault(server, "initialized", mode);
    await assert.rejects(readAvailableModels(posix(server, probes("absent"))), staged("start", true, `${BASE} (stage: start)`));
    assert.deepEqual(attempted, ["initialize", "initialized"]);
    assert.deepEqual(server.kills, ["SIGTERM", "SIGKILL"]);
  });

  test(`an initialized transport ${mode} keeps the start stage when cleanup stays unconfirmed`, async () => {
    const server = fakeServer(), attempted = writeFault(server, "initialized", mode);
    await assert.rejects(readAvailableModels({ ...posix(server, probes("present")), cleanupGraceMs: 100 }),
      staged("start", false, `${BASE} (stage: start; cleanup unconfirmed)`));
    assert.ok(!attempted.includes("model/list"));
  });
}

test("a transport failure of initialize or model/list keeps its own stage", async () => {
  const early = fakeServer();
  writeFault(early, "initialize", "throw");
  await assert.rejects(readAvailableModels(posix(early, probes("absent"))), staged("start", true, `${BASE} (stage: start)`));
  const late = fakeServer(), attempted = writeFault(late, "model/list", "error-event");
  await assert.rejects(readAvailableModels(posix(late, probes("absent"))), staged("catalog", true, `${BASE} (stage: catalog)`));
  assert.deepEqual(attempted, ["initialize", "initialized", "model/list"]);
});

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
      assert.equal(error.message, "Codex model catalog unavailable or cleanup unconfirmed (stage: cleanup)");
      assert.equal((error as CatalogReadError).stage, "cleanup");
      assert.equal(error.cause, undefined);
      return true;
    });
  assert.equal(signals, 1);
});

test("Windows cleanup rejects surviving tracked children after a successful tree signal", async () => {
  const server = fakeServer(), clock = fakeClock();
  let reads = 0;
  await assert.rejects(readAvailableModels({ executable: "synthetic-codex.exe", platform: "win32", cleanupGraceMs: 100,
    now: clock.now, sleep: clock.sleep, spawn() { return server.child; }, killGroup() { server.stop(); return "sent"; },
    async relations() { return reads++ === 0 ? [{ pid: 12346, ppid: 12345 }] : [{ pid: 12346, ppid: 1 }]; } }), /cleanup unconfirmed/);
  assert.equal(reads, 6);
  assert.deepEqual(clock.sleeps, [25, 25, 25, 25]);
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

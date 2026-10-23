// Issue #667 amendment: bounded POSIX cleanup confirmation and early-path stages, offline only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CatalogReadError, readAvailableModels } from "./model-catalog-process.mts";
import { BASE, fakeClock, fakeServer, posix, probes, staged } from "./model-catalog-process.fixture.mts";

const CLEANUP = `${BASE} (stage: cleanup)`, START = `${BASE} (stage: start)`;
const START_UNCONFIRMED = `${BASE} (stage: start; cleanup unconfirmed)`;

test("a present group is re-signalled and confirmed only by the following ESRCH", async () => {
  const server = fakeServer(), probe = probes("present", "absent"), clock = fakeClock();
  assert.equal((await readAvailableModels(posix(server, probe, clock))).complete, true);
  assert.deepEqual(probe.seen, ["present", "absent"]);
  assert.deepEqual(clock.sleeps, [25]);
  assert.deepEqual(server.kills, ["SIGKILL", "SIGKILL"]);
});

test("a group still present at the probe cap fails closed after bounded re-signals", async () => {
  const server = fakeServer(), probe = probes("present"), clock = fakeClock();
  await assert.rejects(readAvailableModels({ ...posix(server, probe, clock), cleanupGraceMs: 100 }), staged("cleanup", false, CLEANUP));
  assert.equal(probe.seen.length, 5);
  assert.deepEqual(clock.sleeps, [25, 25, 25, 25]);
  assert.equal(server.kills.length, 6);
});

test("a denied group is asked again but never re-signalled", async () => {
  const server = fakeServer(), probe = probes("denied");
  await assert.rejects(readAvailableModels({ ...posix(server, probe), cleanupGraceMs: 100 }), staged("cleanup", false, CLEANUP));
  assert.deepEqual(server.kills, ["SIGKILL"]);
});

test("denied, then present, then absent confirms after one re-signal", async () => {
  const server = fakeServer(), probe = probes("denied", "present", "absent"), clock = fakeClock();
  assert.equal((await readAvailableModels(posix(server, probe, clock))).complete, true);
  assert.equal(server.kills.length, 2);
  assert.deepEqual(clock.sleeps, [25, 25]);
});

test("an invalid cleanup grace is rejected before any process is spawned", async () => {
  for (const cleanupGraceMs of [NaN, Infinity, -Infinity, -1, 0, 0.5, 10_001]) {
    let spawned = 0;
    const server = fakeServer(), probe = probes("denied");
    await assert.rejects(readAvailableModels({ ...posix(server, probe), cleanupGraceMs, spawn() { spawned++; return server.child; } }),
      staged("start", true, START));
    assert.equal(spawned, 0, String(cleanupGraceMs));
    assert.equal(probe.seen.length, 0);
  }
});

test("a stalled clock cannot extend the probe loop beyond its cap", async () => {
  const sleeps: number[] = [], probe = probes("denied");
  await assert.rejects(readAvailableModels({ ...posix(fakeServer(), probe), cleanupGraceMs: 100,
    now: () => 0, sleep: async (ms: number) => { sleeps.push(ms); } }), staged("cleanup", false, CLEANUP));
  assert.equal(probe.seen.length, 5);
  assert.deepEqual(sleeps, [25, 25, 25, 25]);
});

test("a backwards clock cannot extend the probe loop beyond its cap", async () => {
  let t = 0;
  const probe = probes("denied");
  await assert.rejects(readAvailableModels({ ...posix(fakeServer(), probe), cleanupGraceMs: 100,
    now: () => (t -= 100), sleep: async () => {} }), staged("cleanup", false, CLEANUP));
  assert.equal(probe.seen.length, 5);
});

test("an opened hook failure is a start failure with one confirmed cleanup", async () => {
  const server = fakeServer();
  await assert.rejects(readAvailableModels({ ...posix(server, probes("absent")),
    opened() { throw new Error("synthetic-opened"); } }), staged("start", true, START));
  assert.equal(server.kills.length, 1);
});

test("an opened hook failure keeps the start stage when cleanup stays unconfirmed", async () => {
  await assert.rejects(readAvailableModels({ ...posix(fakeServer(), probes("present")), cleanupGraceMs: 100,
    opened() { throw new Error("synthetic-opened"); } }), staged("start", false, START_UNCONFIRMED));
});

test("an opened hook failure on Windows is not replaced by a relations error", async () => {
  const server = fakeServer();
  await assert.rejects(readAvailableModels({ executable: "synthetic-codex.exe", platform: "win32", spawn() { return server.child; },
    killGroup() { server.stop(); return "sent"; }, async relations() { throw new Error("synthetic-relations"); },
    opened() { throw new Error("synthetic-opened"); } }), staged("start", false, START_UNCONFIRMED));
});

test("invalid catalog limits are a start failure without any protocol message", async () => {
  const server = fakeServer();
  await assert.rejects(readAvailableModels({ ...posix(server, probes("absent")), timeoutMs: 0 }), staged("start", true, START));
  assert.equal(server.methods.includes("initialize"), false);
});

test("invalid catalog limits keep the start stage when cleanup stays unconfirmed", async () => {
  await assert.rejects(readAvailableModels({ ...posix(fakeServer(), probes("present")), timeoutMs: 0, cleanupGraceMs: 100 }),
    staged("start", false, START_UNCONFIRMED));
});

test("invalid catalog limits on Windows keep the start stage over a relations error", async () => {
  const server = fakeServer();
  await assert.rejects(readAvailableModels({ executable: "synthetic-codex.exe", platform: "win32", spawn() { return server.child; },
    killGroup() { server.stop(); return "sent"; }, async relations() { throw new Error("synthetic-relations"); }, timeoutMs: 0 }),
  staged("start", false, START_UNCONFIRMED));
});

test("a server request carries the stage of the method in flight", async () => {
  await assert.rejects(readAvailableModels(posix(fakeServer(true, undefined, "initialize"), probes("absent"))), staged("start", true, START));
  await assert.rejects(readAvailableModels(posix(fakeServer(true, undefined, "model/list"), probes("absent"))),
    staged("catalog", true, `${BASE} (stage: catalog)`));
});

test("the public error normalises a cleanup stage and keeps the finite message list", () => {
  const cleanup = new CatalogReadError("cleanup", true);
  assert.equal(cleanup.cleanupConfirmed, false);
  assert.equal(cleanup.message, CLEANUP);
  assert.ok(new CatalogReadError("catalog", false).message.endsWith("(stage: catalog; cleanup unconfirmed)"));
  assert.equal(new CatalogReadError().message, BASE);
});

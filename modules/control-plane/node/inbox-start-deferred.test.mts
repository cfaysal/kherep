import assert from "node:assert/strict";
import test from "node:test";

import { NodeClient } from "./client.mts";
import type { NodePaths } from "./config.mts";
import { startDaemon } from "./daemon.mts";
import { readDaemonState, type DaemonState } from "./daemon-state.mts";
import { captureRuntimeSourceIdentity } from "./daemon-source.mts";
import { getSent } from "./exchange.mts";
import { getMessage } from "./inbox.mts";
import { fakeSocket, fixture, seconds, until } from "./inbox-start-fixture.mts";
import { MAINTENANCE_SLICE_MS } from "./inbox-start.mts";
import { healthy } from "./service-lifecycle.mts";
import type { ServiceAdapter, ServiceBinding } from "./service-types.mts";

// Issue #581: the start maintenance (issue #520: settle answered sent records,
// then purge the inbox) runs after the daemon's first authenticated connection,
// so the health stage's only signal, connectedAt, never waits for the queue.

test("T1: the start maintenance runs after the first authenticated connection, settle before purge", async (t) => {
  const node = fixture(t, { inbox: 300, sent: 100 });
  const socket = fakeSocket(t);
  const logs: string[] = [];
  let atConnect: { state: DaemonState | null; logs: string[]; sent?: string; reply: boolean } | null = null;
  const log = (line: string): void => {
    logs.push(line);
    if (line.startsWith("kherep-node: connected as ")) {
      atConnect = { state: readDaemonState(node.paths), logs: [...logs], sent: getSent(node.paths, node.answered)?.state,
        reply: getMessage(node.paths.inbox, node.oldReply) !== null };
    }
  };
  const handle = startDaemon(node.config, node.paths, log, async () => []);
  t.after(() => handle.stop());
  assert.equal(getSent(node.paths, node.answered)?.state, "delivered", `nothing ran before connect; log:\n${logs.join("\n")}`);
  assert.ok(getMessage(node.paths.inbox, node.oldReply), "the old reply is still there before connect");

  socket.open();
  socket.feed("event", { name: "auth.ok" }, 0);
  await until(() => atConnect !== null, logs);
  const connected = atConnect!;
  assert.ok(connected.state?.connectedAt, "connectedAt is recorded before the connected line");
  assert.equal(connected.logs.some((line) => line.includes("before the inbox purge") || line.includes("older than 7 days")), false,
    connected.logs.join("\n"));
  assert.deepEqual([connected.sent, connected.reply], ["delivered", true], "the maintenance had not run at connect");

  await until(() => seconds(logs) !== null, logs);
  assert.equal(getSent(node.paths, node.answered)?.state, "replied");
  assert.equal(getMessage(node.paths.inbox, node.oldReply), null, "the old reply was purged");
  const settled = logs.indexOf("kherep-node: recorded 1 sent message(s) replied before the inbox purge");
  const purged = logs.indexOf("kherep-node: removed 1 inbox message(s) older than 7 days");
  assert.ok(settled > 0 && settled < purged, logs.join("\n"));
  assert.match(logs.find((line) => line.startsWith("kherep-node: connected as "))!, /^kherep-node: connected as \S+ \(\d+\.\d s after start, process up \d+\.\d s\)$/);
  handle.stop();
  await handle.done;
});

// Acceptance 2: the real healthy() against the real daemon.json, in the
// daemon's own process. What it asserts is an order, not a duration: the state
// the health stage accepts is the one the daemon records at connectedAt, and at
// that moment the start maintenance has not begun. The poll sleeps one turn of
// the event loop instead of 100 ms, so its accepting check is the immediate
// queued before the maintenance's first slice (both are immediates, in order),
// on any host speed and for any queue. On the old code the maintenance ran on
// the start path, before connectedAt, so the accepted state already shows its
// work. The client's auth handling is stubbed (daemon-state.test.mts): runtime
// discovery probes loopback ports. The session listing never answers: the
// initial snapshot's refusal check reads the whole inbox on the daemon's
// thread and is not under test here (issue #487 family).
test("T2: the health stage accepts the connection before the start maintenance has begun, and the maintenance then runs in slices", async (t) => {
  const node = fixture(t, { inbox: 3000, sent: 1500 });
  const socket = fakeSocket(t);
  const original = { frame: NodeClient.prototype.onFrame, refresh: NodeClient.prototype.refreshPolicy };
  t.after(() => { NodeClient.prototype.onFrame = original.frame; NodeClient.prototype.refreshPolicy = original.refresh; });
  NodeClient.prototype.refreshPolicy = async () => [];
  NodeClient.prototype.onFrame = async function (this: NodeClient) { this.authenticated = true; return []; };
  // The checkout under test may be dirty while it is edited, which leaves its
  // identity unverified and sourceMatches false. The identity captured here is
  // the one the daemon records; it is treated as verified on both sides.
  const source = { ...captureRuntimeSourceIdentity(), verified: true };
  const same = (state: DaemonState | null): boolean =>
    state?.source?.root === source.root && state.source.commit === source.commit && state.source.digest === source.digest;
  const logs: string[] = [];
  const maintenanceLines = (): string[] => logs.filter((line) => /before the inbox purge|older than 7 days|start maintenance/.test(line));
  let slices = 0; // slices begun
  // #589 item 1: the slicer reads a clock that advances CLOCK_STEP_MS per read, so a slice holds exactly
  // MAINTENANCE_SLICE_MS / CLOCK_STEP_MS = 5 steps on any host. The pass has at least one step per sent and per
  // inbox record read, so its slice count has a fixed lower bound. STEPS_PER_SLICE is written out, not derived
  // from the constant: it pins the 50 ms slice (a longer production slice is the regression this guards).
  let tick = 0;
  const CLOCK_STEP_MS = 10;
  const STEPS_PER_SLICE = 5;
  const STEPS_AT_LEAST = 3000 + 1500;
  // What the health stage's check sees the first time connectedAt is recorded.
  let accepted: { slices: number; sent?: string; reply: boolean; lines: string[] } | null = null;
  const readState = (paths: NodePaths): DaemonState | null => {
    const state = readDaemonState(paths);
    if (state?.connectedAt && !accepted) accepted = { slices, sent: getSent(node.paths, node.answered)?.state,
      reply: getMessage(node.paths.inbox, node.oldReply) !== null, lines: maintenanceLines() };
    return state && same(state) ? { ...state, source } : state;
  };
  const binding: ServiceBinding = { serviceName: "org.example.kherep-node", platform: "darwin", workspace: node.root,
    configRoot: node.root, nodeExecutable: process.execPath, source };
  const adapter = { processOwned: async (pid: number) => pid === process.pid } as unknown as ServiceAdapter;
  const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  const health = healthy(binding, undefined, { paths: node.paths, adapter, readDaemonState: readState, sleep: turn });
  const handle = startDaemon(node.config, node.paths, (line) => logs.push(line), () => new Promise<never>(() => {}), undefined,
    { name: binding.serviceName, platform: "darwin" }, {}, { yield: async () => { await turn(); slices++; }, clock: () => (tick += CLOCK_STEP_MS) });
  t.after(() => handle.stop());
  socket.open();
  socket.feed("event", { name: "auth.ok" }, 0);
  const state = await health;
  assert.equal(state.pid, process.pid);
  assert.ok(same(readDaemonState(node.paths)), "the daemon recorded the identity the binding carries");
  assert.deepEqual(accepted, { slices: 0, sent: "delivered", reply: true, lines: [] },
    "the health stage accepted a connection the start maintenance had run before");

  await until(() => seconds(logs) !== null, logs);
  assert.equal(getSent(node.paths, node.answered)?.state, "replied");
  assert.equal(getMessage(node.paths.inbox, node.oldReply), null, "the old reply was purged");
  assert.equal(MAINTENANCE_SLICE_MS, STEPS_PER_SLICE * CLOCK_STEP_MS, "the slice length this test pins");
  const expected = Math.floor(STEPS_AT_LEAST / STEPS_PER_SLICE);
  assert.ok(slices >= expected, `the maintenance ran in ${slices} slice(s), at least ${expected} expected, done in ${seconds(logs)} s; log:\n${maintenanceLines().join("\n")}`);
  t.diagnostic(`T2: ${slices} slices, done in ${seconds(logs)} s`);
  handle.stop();
  await handle.done;
});

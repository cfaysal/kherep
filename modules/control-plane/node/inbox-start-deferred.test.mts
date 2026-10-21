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

// Acceptance 2: the real healthy() with a short deadline against the real
// daemon.json. In an upgrade the health stage is another process; here it
// shares the daemon's thread, so what neither grows with the queue nor delays
// connectedAt is held off its path. The client's auth handling is stubbed
// (daemon-state.test.mts): runtime discovery probes loopback ports. The
// session listing never answers: the initial snapshot's refusal check reads
// the whole inbox on the daemon's thread after connectedAt was recorded.
// DEADLINE_MS leaves room for the source identity the daemon captures before
// connect, whose cost depends on the source tree, not on the queue.
test("T2: the health stage sees the connection within its deadline while a large queue is maintained", async (t) => {
  const DEADLINE_MS = 1500;
  const node = fixture(t, { inbox: 6000, sent: 3000 });
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
  const readState = (paths: NodePaths): DaemonState | null => {
    const state = readDaemonState(paths);
    return state && same(state) ? { ...state, source } : state;
  };
  const binding: ServiceBinding = { serviceName: "org.example.kherep-node", platform: "darwin", workspace: node.root,
    configRoot: node.root, nodeExecutable: process.execPath, source };
  const adapter = { processOwned: async (pid: number) => pid === process.pid } as unknown as ServiceAdapter;
  const logs: string[] = [];

  const health = healthy(binding, undefined, { paths: node.paths, adapter, readDaemonState: readState, timeoutMs: DEADLINE_MS });
  const handle = startDaemon(node.config, node.paths, (line) => logs.push(line), () => new Promise<never>(() => {}), undefined,
    { name: binding.serviceName, platform: "darwin" });
  t.after(() => handle.stop());
  socket.open();
  socket.feed("event", { name: "auth.ok" }, 0);
  const state = await health;
  assert.equal(state.pid, process.pid);
  assert.ok(same(readDaemonState(node.paths)), "the daemon recorded the identity the binding carries");

  await until(() => seconds(logs) !== null, logs);
  const took = seconds(logs)!;
  // Precondition against a vacuous pass, after the health stage: on the old code this work ran before connect.
  assert.ok(took * 1000 > DEADLINE_MS, `fixture too small for this host: the start maintenance took ${took} s, `
    + `not more than the ${DEADLINE_MS} ms deadline`);
  handle.stop();
  await handle.done;
});

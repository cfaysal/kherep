import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { DirectoryBody } from "../protocol-messages.mts";
import { nodePaths, writeConfig, type NodePaths } from "./config.mts";
import { checkQueueDrain } from "./doctor-drain.mts";
import { writeDirectory } from "./exchange.mts";

// Issue #441, part B: `queueDrain` reads the control plane's queue for this
// node from the last fetched directory, and nothing else.
const FIXTURE = JSON.parse(fs.readFileSync(new URL("../fixtures/directory-intake.json", import.meta.url), "utf8")) as
  { directory: DirectoryBody; truncated: DirectoryBody };
const F = Date.parse(FIXTURE.directory.fetchedAt);
const NOW = F + 30_000;
const idOf = (name: string) => FIXTURE.directory.nodes.find((n) => n.name === name)!.nodeId;

function host(t: test.TestContext, own: string | null, directory: DirectoryBody | null = FIXTURE.directory): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-doctor-drain-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  if (own) writeConfig(paths.config, { version: 1, controlUrl: "https://control.example.invalid", nodeId: own, name: "synthetic",
    publicKey: "x", privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: new Date(0).toISOString() });
  if (directory) writeDirectory(paths, directory);
  return paths;
}

test("queueDrain fails for a stalled own queue and counts the listed peers", (t) => {
  const paths = host(t, idOf("node-stalled"));
  const check = checkQueueDrain(paths, NOW);
  assert.deepEqual(check, { ok: false, state: "stalled", measured: true, fetchedAt: FIXTURE.directory.fetchedAt, directoryAgeSeconds: 30,
    truncated: false, queued: 3, oldestQueuedAgeSeconds: 720, lastAcceptedAgeSeconds: 1500, connection: "online",
    peers: { listed: 4, stalled: 0, waiting: 1, empty: 2, unknown: 1 },
    detail: "3 queued messages wait at the control plane, the oldest for 12 min; this node is connected" });
  // Counts, states and times only: no node name, id, session, path or text.
  const text = JSON.stringify(check);
  for (const n of FIXTURE.directory.nodes) for (const leak of [n.name, n.nodeId]) assert.equal(text.includes(leak), false, leak);
  assert.equal(text.includes(paths.dir), false);
});

test("queueDrain passes for an empty or a waiting own queue", (t) => {
  const empty = checkQueueDrain(host(t, idOf("node-empty-new")), NOW);
  assert.deepEqual([empty.ok, empty.state, empty.measured, empty.queued, empty.oldestQueuedAgeSeconds, empty.lastAcceptedAgeSeconds],
    [true, "empty", true, 0, null, null]);
  const waiting = checkQueueDrain(host(t, idOf("node-waiting")), NOW);
  assert.deepEqual([waiting.ok, waiting.state, waiting.queued, waiting.oldestQueuedAgeSeconds, waiting.connection],
    [true, "waiting", 2, 40, "offline"]);
});

test("queueDrain is UNKNOWN, never zero, whenever the queue was not measured", (t) => {
  const unknown = (paths: NodePaths, now = NOW) => {
    const check = checkQueueDrain(paths, now);
    assert.deepEqual([check.ok, check.measured, check.state], [false, false, "unknown"], JSON.stringify(check));
    assert.equal(check.queued, undefined);
    return String(check.detail);
  };
  assert.equal(unknown(host(t, idOf("node-unknown"))), "the control plane did not report this node's queue; it may run an older Worker");
  assert.equal(unknown(host(t, idOf("node-empty"), null)), "no directory.json; the daemon has not fetched a session directory yet");
  const dir = host(t, idOf("node-empty"), null);
  fs.mkdirSync(dir.directory);
  assert.equal(unknown(dir), "directory.json is unreadable or invalid");
  const invalid = host(t, idOf("node-empty"), null);
  fs.writeFileSync(invalid.directory, JSON.stringify({ nodes: "x" }));
  assert.equal(unknown(invalid), "directory.json is unreadable or invalid");
  assert.equal(unknown(host(t, idOf("node-empty")), F + 3 * 60_000 + 1), "directory.json is older than 3 min; is the daemon running?");
  assert.equal(unknown(host(t, idOf("node-empty")), F - 2 * 60_000), "directory.json is dated ahead of this clock");
  assert.equal(unknown(host(t, idOf("node-empty")), Number.NaN), "this host's clock reading is not usable");
  const absent = "00000000-0000-4000-8000-0000000001ff";
  assert.equal(unknown(host(t, absent)), "this node is not listed in the directory");
  assert.equal(unknown(host(t, absent, FIXTURE.truncated)), "this node is not listed in a truncated directory");
  assert.equal(unknown(host(t, idOf("node-empty"), FIXTURE.truncated)), "this node is not listed in a truncated directory");
  assert.equal(unknown(host(t, null)), "needs an enrolled node");
  const inconsistent = host(t, idOf("node-empty"), { ...FIXTURE.directory, nodes: [{ ...FIXTURE.directory.nodes[2]!,
    intake: { lastAcceptedAt: null, oldestQueuedAt: FIXTURE.directory.fetchedAt, queued: 0 } }] });
  assert.equal(unknown(inconsistent), "the control plane's intake record for this node is inconsistent");
});

test("queueDrain counts only the listed peers of a truncated directory and says so", (t) => {
  const check = checkQueueDrain(host(t, idOf("node-stalled"), FIXTURE.truncated), NOW);
  assert.deepEqual([check.ok, check.state, check.truncated, check.peers], [false, "stalled", true,
    { listed: 1, stalled: 0, waiting: 0, empty: 0, unknown: 1 }]);
  assert.match(String(check.detail), /; the directory was truncated, unlisted peers are not counted$/);
});

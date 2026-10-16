import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { RELAY_MAX_AGE_MS } from "./codex-fork-admission.mts";
import { forkAttempts, forkAttemptsPath } from "./codex-fork-attempts.mts";
import { FORK_OWNER } from "./codex-fork-fixture.mts";
import { forkTestTimeouts, resetForkFeatureCache } from "./codex-fork-reply.mts";
import { relayNode, type RelayNode } from "./codex-fork-relay-fixture.mts";
import { markRelayDue, resetRelayState } from "./codex-fork-relay.mts";
import { relayBookkeeping } from "./codex-fork-relay-pass.mts";
import { FAST } from "./codex-fork-run-fixture.mts";
import { resetMcpCache } from "./codex-mcp.mts";
import { getOutbox } from "./exchange.mts";
import { markOffered, writeJsonAtomic } from "./inbox.mts";
import { getProxied, proxiedFileOf } from "./inbox-proxied.mts";

// Issue #408, PR 4, review WX443-1 and WX443-2: the relay bookkeeping
// (owner-first withdrawal and the D19 bounded cleanup) is driven by the
// sidecars in inbox/proxied/, not by wake.codexFork or the owner candidates.
// With the section absent nothing is sent, forked, created, started or audited.
// Synthetic fixtures only; no Control Plane, no native fork, no real CLI.

test.beforeEach(() => { resetMcpCache(); resetForkFeatureCache(); forkTestTimeouts.value = FAST; });
test.after(() => { forkTestTimeouts.value = undefined; });

const OTHER = "40840000-0000-4000-8000-0000000000ee";
const noFlag = (n: RelayNode): void => n.policy((p) => { delete p.wake.codexFork; });
const state = (n: RelayNode, id: string): string => n.attempt(id).state;
const unresolved = (n: RelayNode, id: string): string => typeof getProxied(n.paths.inbox, id)?.unresolvedAt;
const relayOf = (n: RelayNode, id: string): string => n.attempt(id).relayMessageId!;

// A relay sent once without any status, then a daemon restart.
async function sentOnce(t: test.TestContext) {
  const n = relayNode(t);
  const id = n.add();
  n.seed(id);
  n.sweep();
  assert.equal((await n.exchange()).length, 1);
  resetRelayState();
  return { n, id };
}

for (const owner of ["fresh", "missing"] as const) {
  test(`WX443-1: codexFork removed, ${owner} owner: the owner's read withdraws and the held relay is cleaned up, unaudited`, async (t) => {
    const { n, id } = await sentOnce(t);
    const audit = n.audit();
    n.tick(RELAY_MAX_AGE_MS + 1);
    markOffered(n.paths.inbox, id);
    noFlag(n);
    assert.equal(n.deps().policy.wake?.codexFork, undefined);
    if (owner === "fresh") n.session({ lastSeen: new Date(n.deps().now!()).toISOString() });
    else n.session(null);
    await n.poll();
    await n.poll();
    assert.deepEqual([state(n, id), n.outbox(), unresolved(n, id), n.app.runs.length, n.turns()], ["superseded", [], "string", 0, []]);
    assert.deepEqual(n.audit(), audit, "no audit line while the section is absent");
    assert.deepEqual(n.logs.filter((line) => line.includes("relay held")), []);
    assert.deepEqual(await n.exchange(), []);
  });
}

for (const owner of ["fresh", "stale", "missing"] as const) {
  test(`WX443-2: the poll reconciles a held relay of a ${owner} owner; fork-superseded audited once`, async (t) => {
    const { n, id } = await sentOnce(t);
    markOffered(n.paths.inbox, id);
    n.tick(RELAY_MAX_AGE_MS + 1);
    if (owner === "fresh") n.session({ lastSeen: new Date(n.deps().now!()).toISOString() });
    if (owner === "missing") n.session(null);
    await n.poll();
    await n.poll();
    assert.deepEqual([state(n, id), n.outbox(), unresolved(n, id), n.app.runs.length, n.turns()], ["superseded", [], "string", 0, []]);
    assert.deepEqual(n.audit(), ["fork-superseded"]);
  });
}

test("control: codexFork absent and no relay artefacts: one readdir of inbox/proxied, nothing created, started or sent", async (t) => {
  const n = relayNode(t);
  n.add();
  noFlag(n);
  const deps = n.deps();
  const calls = ["readdirSync", "readFileSync", "lstatSync", "writeFileSync", "rmSync"].map((name) => t.mock.method(fs, name as "rmSync"));
  try { relayBookkeeping(deps, n.log); } finally { t.mock.restoreAll(); }
  assert.deepEqual(calls.map((c) => c.mock.callCount()), [1, 0, 0, 0, 0]);
  assert.equal(calls[0]!.mock.calls[0]!.arguments[0], path.join(n.paths.inbox, "proxied"));
  assert.equal(fs.existsSync(path.join(n.paths.inbox, "proxied")), false);
  assert.deepEqual([n.logs, n.audit(), n.outbox()], [[], [], []]);
  await n.poll();
  assert.deepEqual(await n.exchange(), []);
  assert.deepEqual([fs.existsSync(forkAttemptsPath(n.paths, FORK_OWNER)), n.app.runs.length, n.turns()], [false, 0, []]);
  assert.equal(fs.existsSync(path.join(n.paths.inbox, "proxied")), false);
});

test("control: codexFork absent never sends, forks or audits a held relay; only the bound removes the record", async (t) => {
  const n = relayNode(t);
  const id = n.add();
  n.seed(id);
  n.sweep();
  const relayId = relayOf(n, id);
  noFlag(n);
  n.session({ lastSeen: new Date(n.deps().now!()).toISOString() });
  for (let i = 0; i < 2; i++) {
    await n.poll();
    assert.deepEqual(await n.exchange(), []);
  }
  n.add();
  await n.poll();
  assert.deepEqual([forkAttempts(n.paths, FORK_OWNER).length, n.app.runs.length, n.turns(), state(n, id), n.audit()], [1, 0, [], "completed", []]);
  assert.deepEqual(n.outbox(), [`${relayId}.json`]);
  n.tick(RELAY_MAX_AGE_MS + 1);
  await n.poll();
  assert.deepEqual([n.outbox(), getProxied(n.paths.inbox, id), state(n, id), n.audit()], [[], null, "completed", []]);
  assert.deepEqual(await n.exchange(), []);
});

test("the pass keeps provenance after a restart: a previous daemon's record is kept as unconfirmed", (t) => {
  const n = relayNode(t);
  const id = n.add();
  n.seed(id);
  n.sweep();
  const relayId = relayOf(n, id);
  resetRelayState();
  markOffered(n.paths.inbox, id);
  n.session(null);
  relayBookkeeping(n.deps(), n.log);
  assert.deepEqual([state(n, id), getOutbox(n.paths, relayId)?.messageId, typeof getProxied(n.paths.inbox, id)?.unconfirmedAt],
    ["superseded", relayId, "string"]);
});

test("control: the pass withdraws a record this process wrote and never sent exactly", (t) => {
  const n = relayNode(t);
  const id = n.add();
  n.seed(id);
  n.sweep();
  markOffered(n.paths.inbox, id);
  n.session(null);
  relayBookkeeping(n.deps(), n.log);
  assert.deepEqual([state(n, id), n.outbox(), getProxied(n.paths.inbox, id)], ["superseded", [], null]);
});

// Superseded after a send: the record stays as the base of a late status.
async function supersededAfterSend(t: test.TestContext) {
  const { n, id } = await sentOnce(t);
  markOffered(n.paths.inbox, id);
  n.sweep();
  const relayId = relayOf(n, id);
  assert.deepEqual([state(n, id), n.outbox()], ["superseded", [`${relayId}.json`]]);
  return { n, id, relayId, file: proxiedFileOf(n.paths.inbox, id) };
}

test("a superseded relay whose sidecar names another relay is cleaned up after the bound; the sidecar stays untouched", async (t) => {
  const { n, file } = await supersededAfterSend(t);
  writeJsonAtomic(file, { ...JSON.parse(fs.readFileSync(file, "utf8")), relayMessageId: OTHER });
  const bytes = fs.readFileSync(file);
  n.tick(RELAY_MAX_AGE_MS + 1);
  await n.poll();
  assert.deepEqual(n.outbox(), []);
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test("a superseded relay whose sidecar is missing is cleaned up by the sweep after the bound; no sidecar is created", async (t) => {
  const { n, id, file } = await supersededAfterSend(t);
  fs.rmSync(file);
  n.tick(RELAY_MAX_AGE_MS + 1);
  markRelayDue(FORK_OWNER);
  n.sweep();
  assert.deepEqual([n.outbox(), getProxied(n.paths.inbox, id)], [[], null]);
});

test("control: an outbox record at the relay id that is not this attempt's relay is never removed", async (t) => {
  const { n, relayId } = await supersededAfterSend(t);
  const record = path.join(n.paths.outbox, `${relayId}.json`);
  writeJsonAtomic(record, { ...JSON.parse(fs.readFileSync(record, "utf8")), proxyOf: OTHER });
  n.tick(RELAY_MAX_AGE_MS + 1);
  await n.poll();
  markRelayDue(FORK_OWNER);
  n.sweep();
  assert.deepEqual(n.outbox(), [`${relayId}.json`]);
});

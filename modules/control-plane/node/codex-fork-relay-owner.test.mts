import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { forkAttempts } from "./codex-fork-attempts.mts";
import { FORK_OWNER } from "./codex-fork-fixture.mts";
import { relayNode, type RelayNode } from "./codex-fork-relay-fixture.mts";
import type { CodexDeps } from "./codex-process.mts";
import { CODEX_ACTIVE_MS } from "./codex-sessions.mts";
import { getMessage, markOffered } from "./inbox.mts";
import { getProxied } from "./inbox-proxied.mts";
import { writeTask } from "./task-records.mts";

// Issue #408, PR 4, design r3 section 2.3 RG-5 (WX2): the owner's recorded
// session state is re-validated with admission's own clauses before the
// outbox write and at every proxy send. A fork takes minutes; an accepted
// original is no idle proof. Nothing here spends a turn or starts a helper.

const TASK = "00000000-0000-4000-8000-0000000000f1";
const iso = (ms: number): string => new Date(ms).toISOString();
const now = (n: RelayNode): number => n.deps().now!();

type Case = { name: string; code: string; apply: (n: RelayNode) => void; extra?: CodexDeps; anyListed?: true };
const CASES: Case[] = [
  { name: "a turn in progress", code: "fork-not-idle", apply: (n) => n.session({ lastEvent: "UserPromptSubmit" }) },
  { name: "a Stop that did not end its turn (cancelled, blocked)", code: "fork-not-idle", apply: (n) => n.session({ lastStopEnded: undefined }) },
  { name: "a Stop younger than idleAfterSeconds", code: "fork-not-idle", apply: (n) => n.session({ lastStopAt: iso(now(n) - 1000) }) },
  { name: "a bypass permission mode", code: "permission-mode", apply: (n) => n.session({ permissionMode: "bypassPermissions" }) },
  { name: "no recorded mode, the owner not listed by id", code: "permission-mode-unknown", anyListed: true,
    apply: (n) => n.session({ permissionMode: undefined }) },
  { name: "the session record removed", code: "not-recorded", apply: (n) => n.session(null) },
  { name: "lastSeen older than CODEX_ACTIVE_MS", code: "not-recorded", apply: (n) => n.session({ lastSeen: iso(now(n) - CODEX_ACTIVE_MS - 1) }) },
  { name: "the owner now a task session", code: "task-session", apply: (n) => {
    writeTask(n.paths, { taskId: TASK, runtime: "codex", name: "task-000000f1", cwd: n.cwd, permissionMode: "auto", state: "running",
      startedAt: iso(now(n)), deadline: iso(now(n) + 60_000), updatedAt: iso(now(n)), sessionId: FORK_OWNER }, now(n));
  } },
  { name: "no PostToolUse delivery hook", code: "post-tool-hook-missing", apply: () => {}, extra: { postToolHook: () => false } },
];

function owner(t: test.TestContext, c: Case) {
  const n = relayNode(t);
  if (c.anyListed) n.policy((p) => { p.wake.sessions = ["*"]; });
  const file = path.join(n.paths.codexSessions, `${FORK_OWNER}.json`);
  const idle = fs.readFileSync(file, "utf8");
  const restore = (): void => {
    fs.writeFileSync(file, idle);
    fs.rmSync(path.join(n.paths.tasks, `${TASK}.json`), { force: true });
  };
  const id = n.add();
  n.seed(id);
  return { n, id, restore };
}

for (const c of CASES) {
  test(`${c.code} (${c.name}): no outbox write while it holds, logged once, nothing spent; restored, relayed once`, (t) => {
    const { n, id, restore } = owner(t, c);
    c.apply(n);
    n.sweep(c.extra);
    n.sweep(c.extra);
    assert.deepEqual([n.outbox(), getProxied(n.paths.inbox, id), n.app.runs.length, n.turns()], [[], null, 0, []]);
    assert.equal(n.logs.filter((line) => line.includes(`relay held: ${c.code}`)).length, 1, n.logs.join("\n"));
    restore();
    n.sweep();
    assert.equal(n.outbox().length, 1, "re-checked at the next poll, not after a 60 s cadence");
  });

  test(`${c.code} (${c.name}) after the outbox write holds the record at the send; restored, sent once`, async (t) => {
    const { n, restore } = owner(t, c);
    n.sweep();
    assert.equal(n.outbox().length, 1);
    c.apply(n);
    assert.deepEqual(await n.exchange(c.extra), []);
    assert.deepEqual(await n.exchange(c.extra), []);
    assert.equal(n.outbox().length, 1, "held, not withdrawn");
    restore();
    assert.equal((await n.exchange()).length, 1);
    assert.deepEqual([n.app.runs.length, n.turns()], [0, []]);
  });
}

test("a busy turn that reads the message withdraws the held record exactly: superseded, nothing sent", async (t) => {
  const { n, id } = owner(t, CASES[0]!);
  n.sweep();
  CASES[0]!.apply(n);
  assert.deepEqual(await n.exchange(), []);
  markOffered(n.paths.inbox, id);
  n.sweep();
  assert.deepEqual([forkAttempts(n.paths, FORK_OWNER)[0]!.state, n.outbox(), getProxied(n.paths.inbox, id)], ["superseded", [], null]);
  assert.notEqual(getMessage(n.paths.inbox, id)?.state, "accepted");
  assert.deepEqual(await n.exchange(), []);
});

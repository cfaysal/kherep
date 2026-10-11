import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { listenerDir, TURN_SPACING_MS } from "./autonomy.mts";
import { codexQueueIdle, pollCodexQueue } from "./codex-queue.mts";
import { CODEX_ACTIVE_MS, recordCodexSession } from "./codex-sessions.mts";
import { deliverForCodex } from "./deliver-codex.mts";
import { getMessage, getMessageProgress, storeMessage } from "./inbox.mts";
import { T0, taskNode } from "./task-fixture.mts";

const OWNER = "01a0db74-0000-7000-8000-000000000001";
const ID = "9e570001-0000-4000-8000-000000000000";
function setup(t: test.TestContext, budget = {}) {
  const node = taskNode(t, { runtimes: ["codex"] }, { wake: { enabled: true, sessions: [OWNER], budget } });
  recordCodexSession(node.paths, OWNER, node.workspace, T0, "default");
  storeMessage(node.paths.inbox, { messageId: ID, toSession: OWNER, text: "synthetic retained content",
    from: { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "synthetic-peer" },
    createdAt: new Date(T0).toISOString() }, T0);
  const dir = listenerDir(node.paths), ticket = path.join(dir, `${OWNER}.busy-hint.json`);
  const metadata = path.join(dir, `${OWNER}.busy-admission.json`);
  fs.mkdirSync(dir, { recursive: true });
  const turns = () => JSON.parse(fs.readFileSync(path.join(dir, `${OWNER}.turns.json`), "utf8")).turns as number[];
  const admission = () => JSON.parse(fs.readFileSync(metadata, "utf8"));
  const poll = async () => {
    pollCodexQueue({ ...node.deps(), codex: { home: path.join(node.root, "empty-codex-home"),
      findCodex: () => { assert.fail("CP admission must never invoke CLI"); } } });
    await codexQueueIdle();
  };
  const retained = () => {
    assert.equal(getMessage(node.paths.inbox, ID)?.state, "accepted");
    assert.equal(getMessage(node.paths.inbox, ID)?.offers, undefined);
  };
  return { ...node, dir, ticket, metadata, turns, admission, poll, retained };
}

for (const fault of ["contention", "persist"]) test(`publication ${fault} retries the same generation and budget`, async (t) => {
  const node = setup(t);
  const obstruction = fault === "contention" ? node.ticket + ".lock" : node.ticket;
  fs.writeFileSync(obstruction, fault === "persist" ? "{broken-synthetic-ticket" : "held");
  await node.poll();
  const before = node.admission();
  assert.equal(before.publishedAt, undefined);
  assert.equal(node.turns().length, 1);
  assert.equal(getMessageProgress(node.paths.inbox, ID)?.code, "retry-pending");
  await node.poll();
  assert.equal(node.admission().ticket.generation, before.ticket.generation);
  assert.equal(node.turns().length, 1);
  fs.unlinkSync(obstruction);
  await node.poll();
  assert.equal(node.admission().ticket.generation, before.ticket.generation);
  assert.equal(node.admission().publishedAt, T0);
  assert.equal(node.turns().length, 1);
  node.retained();
});

test("claimed metadata is not Receive; reoffer after ten minutes requires fresh admission", async (t) => {
  const node = setup(t);
  await node.poll();
  const first = fs.readFileSync(node.ticket, "utf8");
  const input = { hook_event_name: "PostToolUse", session_id: OWNER, permission_mode: "default",
    transcript_path: `/synthetic/rollout-2026-10-10T10-00-00-${OWNER}.jsonl` };
  assert.ok(deliverForCodex(input, { paths: node.paths, now: () => T0 }).includes("New peer messages"));
  assert.equal(deliverForCodex(input, { paths: node.paths, now: () => T0 }), "");
  await node.poll();
  assert.equal(node.turns().length, 1);
  node.retained();
  node.tick(10 * 60_000 + 1);
  await node.poll();
  assert.notEqual(node.admission().ticket.generation, JSON.parse(first).generation);
  assert.equal(node.turns().length, 2);
  assert.equal(JSON.parse(fs.readFileSync(node.ticket, "utf8")).claimed, false);
  node.retained();
});

test("an exhausted budget blocks readmission after the publication interval", async (t) => {
  const node = setup(t, { perHour: 1 });
  await node.poll();
  const first = fs.readFileSync(node.ticket, "utf8");
  node.tick(10 * 60_000 + 1);
  await node.poll();
  assert.equal(fs.readFileSync(node.ticket, "utf8"), first);
  assert.equal(node.turns().length, 1);
  assert.equal(getMessageProgress(node.paths.inbox, ID)?.code, "budget-exhausted");
  node.retained();
});

for (const invalidation of ["ttl", "policy"]) test(`${invalidation} invalidates a failed admission; later publication spends fresh budget`, async (t) => {
  const node = setup(t);
  fs.writeFileSync(node.ticket + ".lock", "held");
  await node.poll();
  const first = node.admission();
  if (invalidation === "ttl") {
    node.tick(CODEX_ACTIVE_MS + 1);
    recordCodexSession(node.paths, OWNER, node.workspace, T0 + CODEX_ACTIVE_MS + 1, "default");
  } else {
    const policy = fs.readFileSync(node.paths.policy, "utf8");
    fs.writeFileSync(node.paths.policy, JSON.stringify({ ...JSON.parse(policy), wake: { enabled: false } }));
    await node.poll();
    fs.writeFileSync(node.paths.policy, policy);
    node.tick(TURN_SPACING_MS + 1);
  }
  fs.unlinkSync(node.ticket + ".lock");
  await node.poll();
  assert.notEqual(node.admission().ticket.generation, first.ticket.generation);
  assert.equal(node.turns().length, 2);
  node.retained();
});

test("restart recovers valid retry metadata; loss of metadata requires new budget", async (t) => {
  const node = setup(t);
  fs.writeFileSync(node.ticket + ".lock", "held");
  await node.poll();
  const first = node.admission();
  fs.unlinkSync(node.ticket + ".lock");
  const restart = (now: number) => {
    const source = `import {nodePaths} from ${JSON.stringify(new URL("./config.mts", import.meta.url).href)};
      import {loadPolicy} from ${JSON.stringify(new URL("./policy.mts", import.meta.url).href)};
      import {pollCodexQueue,codexQueueIdle} from ${JSON.stringify(new URL("./codex-queue.mts", import.meta.url).href)};
      const paths=nodePaths(process.argv[1]);
      pollCodexQueue({paths,policy:loadPolicy(paths.policy),now:()=>Number(process.argv[2]),
        codex:{home:process.argv[1]+"/empty-codex-home",findCodex:()=>{throw Error("no CLI");}}});
      await codexQueueIdle();`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source, node.root, String(now)], {
      encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
  };
  restart(T0);
  assert.equal(node.admission().ticket.generation, first.ticket.generation);
  assert.equal(node.turns().length, 1);
  fs.unlinkSync(node.metadata);
  restart(T0 + TURN_SPACING_MS + 1);
  assert.notEqual(node.admission().ticket.generation, first.ticket.generation);
  assert.equal(node.turns().length, 2);
  node.retained();
});

test("failed CP metadata persistence retains the in-process admission without a queue fallback", async (t) => {
  const node = setup(t);
  fs.mkdirSync(node.metadata);
  fs.writeFileSync(node.ticket + ".lock", "held");
  await node.poll();
  fs.unlinkSync(node.ticket + ".lock");
  await node.poll();
  const published = fs.readFileSync(node.ticket, "utf8");
  await node.poll();
  assert.equal(fs.readFileSync(node.ticket, "utf8"), published);
  assert.equal(node.turns().length, 1);
  assert.equal(fs.existsSync(path.join(node.dir, `${OWNER}.queued.json`)), false);
  node.retained();
});

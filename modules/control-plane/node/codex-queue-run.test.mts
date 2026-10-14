import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { codexCommand } from "./codex-binary.mts";
import { codexNode, fakeCodexBin } from "./codex-fixture.mts";
import { queueProducerIdentity } from "./codex-queue-context.mts";
import { MAX_QUEUE_STDOUT_BYTES, parseQueueAdmission, queueArgs, runQueue } from "./codex-queue-run.mts";

const OWNER = "01a0db01-0000-7000-8000-000000000001";
const QUEUE = "00000001-0000-4000-8000-000000000001";

test("changed executable bytes reject the captured producer before starting a child", async (t) => {
  const fake = fakeCodexBin(t);
  const node = codexNode(t);
  const deps = { ...node.deps(), codex: { findCodex: () => fake.file, home: node.root } };
  const args = queueArgs(OWNER, 1);
  const expected = queueProducerIdentity(fake.file, args, deps);
  const command = codexCommand(fake.file, args, process.platform);
  const script = process.platform === "win32" ? command.args[0]! : fake.file;
  fs.appendFileSync(script, "\n// public synthetic binary drift\n");
  await assert.rejects(runQueue(deps, args, expected), /producer changed/);
  assert.equal(fake.runs().length, 0);
});

test("queue child uses its captured producer home instead of the parent's home", async (t) => {
  const fake = fakeCodexBin(t);
  const node = codexNode(t);
  const home = path.join(node.root, "approved-synthetic-home");
  fs.mkdirSync(home);
  const args = queueArgs(OWNER, 1);
  const command = codexCommand(fake.file, args, process.platform);
  const script = process.platform === "win32" ? command.args[0]! : fake.file;
  const original = fs.readFileSync(script, "utf8");
  const guard = `if (process.env.CODEX_HOME !== ${JSON.stringify(home)}) { process.stderr.write("wrong owner home\\n"); process.exit(1); }\n`;
  fs.writeFileSync(script, original.replace(/^(#![^\n]*\n)?/, (line) => line + guard));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(node.root, "different-parent-home");
  try {
    const result = await runQueue({ ...node.deps(), codex: { findCodex: () => fake.file, home } }, args);
    assert.equal(result.owner, OWNER);
    assert.equal(result.producer.resolvedCodexHome, home);
    assert.ok(result.queueId);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

test("queue admission requires one exact owner and bounded complete stdout", () => {
  const line = `Queued message ${QUEUE} for thread ${OWNER}.`;
  assert.equal(parseQueueAdmission(line, OWNER), QUEUE);
  assert.equal(parseQueueAdmission(line + "\n" + line, OWNER), null);
  assert.equal(parseQueueAdmission(line, QUEUE), null);
  assert.equal(parseQueueAdmission(line, OWNER, true), null);
  assert.equal(parseQueueAdmission("x".repeat(MAX_QUEUE_STDOUT_BYTES) + line, OWNER), null);
});

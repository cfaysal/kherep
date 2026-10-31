import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { BUSY_OWNER, BUSY_BODY, busyFixture } from "./codex-busy-fixture.mts";
import { deliverForCodex } from "./deliver-codex.mts";
import { getMessage, markReported, unreportedStatuses, writeJsonAtomic } from "./inbox.mts";
import { runMsg } from "./msg-cli.mts";

function client(t: test.TestContext, count = 1) {
  const node = busyFixture(t, count, Date.now(), false);
  const call = async (args: string[]) => {
    const out: string[] = [], err: string[] = [];
    const status = await runMsg(["inbox", ...args], { paths: node.paths, env: { CODEX_THREAD_ID: BUSY_OWNER },
      out: line => out.push(line), err: line => err.push(line) });
    return { status, text: out.join("\n"), error: err.join("\n") };
  };
  const receive = () => call(["--from", BUSY_OWNER, "--receive"]);
  const ack = (receipt: string, owner = BUSY_OWNER) => call(["--from", owner, "--ack", receipt]);
  const stop = () => deliverForCodex({ ...node.input, hook_event_name: "Stop", stop_hook_active: true }, { paths: node.paths });
  return { ...node, call, receive, ack, stop };
}
const receiptOf = (text: string): string => {
  const found = text.match(/msg inbox --ack ([0-9a-f-]{36}) --from /);
  assert.ok(found, "complete emitted offer carries explicit processing ACK command");
  return found[1]!;
};

test("receive and ordinary repeated Stop cannot acknowledge processing", async t => {
  const c = client(t), first = await c.receive();
  assert.ok(first.text.includes(BUSY_BODY));
  c.stop(); c.stop();
  assert.equal(getMessage(c.paths.inbox, c.ids[0])?.state, "offered");
});

test("interrupted offers recover immediately without consuming attempts; exact ACK is idempotent and remote receipt stays separate", async t => {
  const c = client(t), first = await c.receive(), token = receiptOf(first.text);
  const again = await c.receive();
  assert.ok(again.text.includes(BUSY_BODY));
  assert.equal(getMessage(c.paths.inbox, c.ids[0])?.offers, 1);
  assert.equal((await c.ack(token)).status, 0);
  assert.equal(getMessage(c.paths.inbox, c.ids[0])?.state, "delivered");
  assert.equal((await c.ack(token)).status, 0);
  assert.ok(unreportedStatuses(c.paths.inbox).some(r => r.messageId === c.ids[0] && r.state === "delivered"));
  assert.match((await c.ack(token)).text, /local.*committed.*Worker.*pending/i);
  markReported(c.paths.inbox, c.ids[0], "delivered", "delivered");
  assert.match((await c.ack(token)).text, /Worker.*persisted.*sender.*not verified/i);
  assert.equal((await c.receive()).text.includes(BUSY_BODY), false);
});

test("ACK fails closed for wrong owner, stale generation, readdressed, refused and never offered", async t => {
  for (const kind of ["owner", "generation", "address", "refused", "never"] as const) await t.test(kind, async sub => {
    const c = client(sub), token = receiptOf((await c.receive()).text), file = path.join(c.paths.inbox, `${c.ids[0]}.json`);
    const record = getMessage(c.paths.inbox, c.ids[0])!;
    if (kind === "generation") writeJsonAtomic(file, { ...record, offeredAt: new Date(0).toISOString() });
    if (kind === "address") writeJsonAtomic(file, { ...record, toSession: "other" });
    if (kind === "refused") writeJsonAtomic(file, { ...record, state: "refused" });
    if (kind === "never") writeJsonAtomic(file, { ...record, state: "accepted", codexOffer: undefined });
    const result = await c.ack(token, kind === "owner" ? "01a0db74-0000-7000-8000-000000000099" : BUSY_OWNER);
    assert.equal(result.status, 1);
    assert.notEqual(getMessage(c.paths.inbox, c.ids[0])?.state, "delivered");
  });
});

test("listing has no receipt or writes; bounded ACK covers only complete output", async t => {
  const c = client(t, 12), listing = await c.call(["--from", BUSY_OWNER]);
  assert.ok(!listing.text.includes("msg inbox --ack"));
  assert.ok(c.ids.every(id => getMessage(c.paths.inbox, id)?.state === "accepted"));
  const received = await c.receive(), token = receiptOf(received.text);
  assert.ok(Buffer.byteLength(received.text) <= 6 * 1024);
  const emitted = c.ids.filter(id => received.text.includes(`Message id: ${id}`));
  assert.ok(emitted.length > 0 && emitted.length < c.ids.length);
  assert.equal((await c.ack(token)).status, 0);
  for (const id of c.ids) assert.equal(getMessage(c.paths.inbox, id)?.state, emitted.includes(id) ? "delivered" : "accepted");
  assert.ok(!fs.readFileSync(path.join(c.paths.inbox, `${c.ids[0]}.json`), "utf8").includes('"receiptText"'));
});

test("oversized batch gives an exact complete receive recovery command and no ACK; single receive then ACK covers all text", async t => {
  const c = client(t), file = path.join(c.paths.inbox, `${c.ids[0]}.json`);
  const text = "Public synthetic large message\n" + "x".repeat(12_000) + "\nFULL-END";
  writeJsonAtomic(file, { ...getMessage(c.paths.inbox, c.ids[0]), text });
  const batch = await c.receive();
  assert.ok(Buffer.byteLength(batch.text) <= 6 * 1024);
  assert.ok(!batch.text.includes("msg inbox --ack"));
  assert.ok(batch.text.includes(`--receive ${c.ids[0]}`));
  const single = await c.call(["--from", BUSY_OWNER, "--receive", c.ids[0]]);
  assert.equal(single.status, 0, single.error);
  assert.ok(single.text.includes(text));
  assert.match(single.text, /output.*truncated.*do not ACK/i);
  assert.equal((await c.ack(receiptOf(single.text))).status, 0);
  assert.equal(getMessage(c.paths.inbox, c.ids[0])?.state, "delivered");
});

test("single receive refuses unowned, terminal, invalid, extra and conflicting selectors", async t => {
  for (const kind of ["owner", "terminal", "invalid", "extra", "all", "ack"] as const) await t.test(kind, async sub => {
    const c = client(sub), file = path.join(c.paths.inbox, `${c.ids[0]}.json`);
    if (kind === "owner") writeJsonAtomic(file, { ...getMessage(c.paths.inbox, c.ids[0]), toSession: "another-owner" });
    if (kind === "terminal") writeJsonAtomic(file, { ...getMessage(c.paths.inbox, c.ids[0]), state: "delivered" });
    const args = ["--from", BUSY_OWNER, "--receive", kind === "invalid" ? "invalid-id" : c.ids[0]!];
    if (kind === "extra") args.push(c.ids[0]!);
    if (kind === "all") args.push("--all");
    if (kind === "ack") args.push("--ack", c.ids[0]!);
    const result = await c.call(args);
    assert.equal(result.status, 1);
    assert.ok(!result.text.includes("msg inbox --ack"));
  });
});

test("ACK and receive reject unrelated option combinations", async t => {
  const c = client(t), token = receiptOf((await c.receive()).text);
  for (const args of [
    ["--from", BUSY_OWNER, "--ack", token, "--to", "another/owner"],
    ["--from", BUSY_OWNER, "--receive", "--wait", "1"],
  ]) assert.equal((await c.call(args)).status, 1);
});

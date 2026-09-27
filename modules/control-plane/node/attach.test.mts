import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { DirectoryBody } from "../protocol-messages.mts";
import { attachFile, readAttachConfig, runAttach } from "./attach.mts";
import { nodePaths, writeConfig, type NodePaths } from "./config.mts";
import { writeDirectory } from "./exchange.mts";

const SELF = "00000000-0000-4000-8000-0000000000aa";
const PEER = "00000000-0000-4000-8000-0000000000cc";
const NOW = Date.UTC(2026, 8, 27);
const BG = "0f0e0d0c-1111-4222-8333-444455556666";
const INTERACTIVE = "1a2b3c4d-1111-4222-8333-444455556666";
const UNKNOWN = "5e6f7a8b-1111-4222-8333-444455556666";
const CODEX = "019a0000-0000-7000-8000-00000000c0de";

const DIRECTORY: DirectoryBody = {
  nodes: [{ nodeId: SELF, name: "win", status: "online" }, { nodeId: PEER, name: "mac", status: "online" }],
  sessions: [
    { nodeId: SELF, sessionId: "a1b2c3d4-0000-4000-8000-000000000001", name: "review", state: "busy", runtime: "claude-code", kind: "background" },
    { nodeId: PEER, sessionId: BG, name: "task-0f0e0d0c", label: "intercom: claude@win", state: "idle", runtime: "claude-code", kind: "background" },
    { nodeId: PEER, sessionId: INTERACTIVE, name: "docs", state: "idle", runtime: "claude-code", kind: "interactive" },
    { nodeId: PEER, sessionId: UNKNOWN, name: "misc", state: "idle", runtime: "claude-code" },
    { nodeId: PEER, sessionId: "s-b1", name: "build", state: "idle", runtime: "claude-code" },
    { nodeId: PEER, sessionId: "s-b2", name: "build", state: "idle", runtime: "claude-code" },
    { nodeId: PEER, sessionId: CODEX, name: "codex-0000c0de", title: "Fix the parser", state: "active", runtime: "codex", kind: "codex" },
  ],
  fetchedAt: new Date(NOW - 30_000).toISOString(),
};

function setup(t: test.TestContext, attach?: unknown): NodePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-attach-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  writeConfig(paths.config, { version: 1, controlUrl: "https://control.example.com", nodeId: SELF, name: "win", publicKey: "x",
    privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: new Date(0).toISOString() });
  writeDirectory(paths, DIRECTORY);
  if (attach !== undefined) fs.writeFileSync(attachFile(paths), typeof attach === "string" ? attach : JSON.stringify(attach));
  return paths;
}

async function run(paths: NodePaths, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAttach(argv, { paths, now: () => NOW, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err: err.join("\n") };
}

test("a Claude background session gets attach and logs with the 8-character id", async (t) => {
  const r = await run(setup(t), ["mac/intercom: claude@win"]);
  assert.equal(r.code, 0);
  assert.match(r.out[0], /^# mac \(.+\) \/ intercom: claude@win \(0f0e0d0c-.+\), claude-code, background session$/);
  assert.deepEqual(r.out.slice(1), ["claude attach 0f0e0d0c", "claude logs 0f0e0d0c"]);
});

test("an interactive Claude session gets no command, only a note", async (t) => {
  const r = await run(setup(t, { ssh: { mac: "me@mac.example.test" } }), [`${PEER}/docs`]);
  assert.equal(r.code, 0);
  assert.equal(r.out.length, 2);
  assert.match(r.out[1], /^# interactive session: it can only be opened where it runs/);
});

test("a Claude session of unknown kind gets both commands and a caveat", async (t) => {
  const r = await run(setup(t), ["mac/misc"]);
  assert.equal(r.code, 0);
  assert.match(r.out[1], /^# the directory does not say whether this is a background session/);
  assert.deepEqual(r.out.slice(2), ["claude attach 5e6f7a8b", "claude logs 5e6f7a8b"]);
});

test("a Codex session gets its title and codex resume with the full thread id", async (t) => {
  const r = await run(setup(t), ["mac/codex-0000c0de"]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.out.slice(1), ['# title: "Fix the parser"', `codex resume ${CODEX}`]);
});

test("a title is never an address, and unknown or ambiguous targets fail like msg send", async (t) => {
  const paths = setup(t);
  for (const [target, pattern] of [
    ["mac/Fix the parser", /unknown session on mac "Fix the parser"/], ["mac/build", /ambiguous session on mac "build"/],
    ["nowhere/build", /unknown node "nowhere"/], ["mac", /target must be <node>\/<session>/],
  ] as const) {
    const r = await run(paths, [target]);
    assert.equal(r.code, 1, target);
    assert.match(r.err, pattern);
    assert.deepEqual(r.out, []);
  }
  assert.equal((await run(paths, [])).code, 2);
});

test("the SSH prefix comes from a valid mapping by node name or node id", async (t) => {
  const byName = await run(setup(t, { ssh: { mac: "me@mac.example.test" } }), ["mac/codex-0000c0de"]);
  assert.equal(byName.out[2], `ssh -t me@mac.example.test codex resume ${CODEX}`);
  const byId = await run(setup(t, { ssh: { [PEER]: "mac-host" } }), ["mac/intercom: claude@win"]);
  assert.deepEqual(byId.out.slice(1), ["ssh -t mac-host claude attach 0f0e0d0c", "ssh -t mac-host claude logs 0f0e0d0c"]);
  const unmapped = await run(setup(t, { ssh: { other: "x.example.test" } }), ["mac/intercom: claude@win"]);
  assert.equal(unmapped.out[1], "claude attach 0f0e0d0c");
});

test("a session on this node gets no prefix even when the node is mapped", async (t) => {
  const r = await run(setup(t, { ssh: { win: "win.example.test", [SELF]: "win.example.test" } }), ["win/review"]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.out.slice(1), ["claude attach a1b2c3d4", "claude logs a1b2c3d4"]);
});

test("a malformed attach.json is rejected and named", async (t) => {
  for (const bad of ["{not json", [], { ssh: [] }, { ssh: { mac: "-oProxyCommand=evil" } }, { ssh: { mac: "a b" } },
    { ssh: { mac: "" } }, { ssh: { mac: 7 } }, { ssh: { mac: "x".repeat(65) } }, { ssh: {}, extra: 1 }, {}]) {
    const paths = setup(t, bad);
    assert.throws(() => readAttachConfig(paths), (e: Error) => e.message.includes(attachFile(paths)), JSON.stringify(bad));
    const r = await run(paths, ["mac/misc"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /attach\.json/);
    assert.deepEqual(r.out, []);
  }
});

test("a missing attach.json means no prefix", (t) => {
  assert.deepEqual(readAttachConfig(setup(t)), { ssh: {} });
});

test("an id that is not safe to print as a command is refused", async (t) => {
  const paths = setup(t);
  writeDirectory(paths, { ...DIRECTORY, sessions: [{ nodeId: PEER, sessionId: "x; rm -rf", name: "evil", state: "idle", runtime: "codex" }] });
  const r = await run(paths, ["mac/evil"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /not safe/);
});

test("a runtime without an attach command fails", async (t) => {
  const paths = setup(t);
  writeDirectory(paths, { ...DIRECTORY, sessions: [{ nodeId: PEER, sessionId: "s-x", name: "other", state: "idle", runtime: "aider" }] });
  const r = await run(paths, ["mac/other"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /no attach command for runtime "aider"/);
});

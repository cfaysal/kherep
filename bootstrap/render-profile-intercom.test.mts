// Issue #436. The intercom instructions name this host's stable launcher: the
// __KHEREP_NODE__ placeholder becomes launcherCommand(<configRoot>), the
// example target names this node from node.json, and nothing else changes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { launcherCommand } from "../modules/control-plane/node/launcher.mts";
import { INTERCOM_COMMAND, INTERCOM_EXAMPLE_TARGET, intercomValues, renderIntercom } from "./render-intercom.mts";

const HERE = import.meta.dirname;
const REPO = path.resolve(HERE, "..");
const read = (...parts: string[]): string => fs.readFileSync(path.join(REPO, ...parts), "utf8");
const INTERCOM_START = "<!-- kherep-intercom:start -->";
const INTERCOM_END = "<!-- kherep-intercom:end -->";

function tempRoot(t: { after: (fn: () => void) => void }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-intercom-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function enroll(root: string, name: string): void {
  fs.mkdirSync(path.join(root, "control-plane"), { recursive: true });
  fs.writeFileSync(path.join(root, "control-plane", "node.json"), JSON.stringify({
    version: 1, controlUrl: "https://control.example.com", nodeId: "11111111-1111-4111-8111-111111111111", name,
    publicKey: "synthetic", privateKeyFile: "node-ed25519.pem", policyFile: "policy.json", enrolledAt: "2026-10-16T00:00:00.000Z",
  }));
}

test("renderIntercom substitutes exactly the two intercom placeholders and is idempotent", () => {
  const values = { command: 'node "/cfg/bin/kherep-node.mjs"', exampleTarget: "peer/session" };
  const source = `a ${INTERCOM_COMMAND} msg sessions\nb ${INTERCOM_COMMAND} msg send ${INTERCOM_EXAMPLE_TARGET} -- x\n__KHEREP_REPO__ $& $1\n`;
  const rendered = renderIntercom(source, values);
  assert.equal(rendered, `a ${values.command} msg sessions\nb ${values.command} msg send peer/session -- x\n__KHEREP_REPO__ $& $1\n`);
  assert.equal(renderIntercom(rendered, values), rendered);
});

test("intercomValues names the launcher of the config root and this node from node.json", (t) => {
  const root = tempRoot(t);
  assert.deepEqual(intercomValues(root), { command: launcherCommand(root), exampleTarget: "peer/session" });
  enroll(root, "sekhmet");
  assert.deepEqual(intercomValues(root), { command: launcherCommand(root), exampleTarget: "sekhmet/maestro" });
  enroll(root, "not a node name");
  assert.equal(intercomValues(root).exampleTarget, "peer/session");
  fs.writeFileSync(path.join(root, "control-plane", "node.json"), "{ unreadable");
  assert.equal(intercomValues(root).exampleTarget, "peer/session");
});

test("a macOS config root keeps its space and is quoted, and the ~/.claude rewrite does not touch it", () => {
  const root = "/Users/a/Library/Application Support/kherep";
  const command = launcherCommand(root, "darwin");
  assert.equal(command, `node "${root}/bin/kherep-node.mjs"`);
  const rendered = renderIntercom(`${INTERCOM_COMMAND} msg sessions`, { command, exampleTarget: "peer/session" });
  // The rewrite capture.sh (portable_paths) and drift-check.sh apply: CLAUDE_HOME -> ~/.claude.
  assert.equal(rendered.split("/Users/a/.claude").join("~/.claude"), rendered);
});

test("the intercom subcommand renders a file with the config root's command and keeps the source", (t) => {
  const root = tempRoot(t);
  enroll(root, "node-a");
  const src = path.join(root, "src.md");
  const dst = path.join(root, "out", "dst.md");
  const source = `keep\n${INTERCOM_COMMAND} msg send ${INTERCOM_EXAMPLE_TARGET} -- hi\n`;
  fs.writeFileSync(src, source);
  const render = (from: string, to: string) => spawnSync(process.execPath, [path.join(HERE, "render-profile.mts"), "intercom", from, to],
    { encoding: "utf8", env: { ...process.env, KHEREP_CONFIG_DIR: root } });
  const first = render(src, dst);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(fs.readFileSync(dst, "utf8"), `keep\n${launcherCommand(root)} msg send node-a/maestro -- hi\n`);
  assert.equal(fs.readFileSync(src, "utf8"), source);
  const again = path.join(root, "again.md");
  assert.equal(render(dst, again).status, 0);
  assert.equal(fs.readFileSync(again, "utf8"), fs.readFileSync(dst, "utf8"));
  const usage = render(src, "");
  assert.notEqual(usage.status, 0);
  assert.match(usage.stderr, /intercom usage/);
});

test("the Claude sources carry the placeholder: CLAUDE.md in one managed block, ROUTING.md on the intercom line", () => {
  const user = read("claude", "CLAUDE.user.md");
  assert.equal(user.split(INTERCOM_START).length, 2);
  assert.equal(user.split(INTERCOM_END).length, 2);
  const block = user.slice(user.indexOf(INTERCOM_START), user.indexOf(INTERCOM_END));
  for (const line of [`Command: ${INTERCOM_COMMAND}`, "msg sessions", "msg send <node>/<session> -- <text>",
    "msg send --reply-to <messageId> -- <text>", "msg send <node> --new claude|codex --directive", "msg inbox", "msg status <messageId>",
    `Example: ${INTERCOM_COMMAND} msg send ${INTERCOM_EXAMPLE_TARGET} -- "ready for review"`]) {
    assert.ok(block.includes(line), line);
  }
  for (const routing of [read("claude", "teams", "kherep", "ROUTING.md"), read("codex", "ROUTING.md")]) {
    assert.ok(routing.includes(`\`${INTERCOM_COMMAND} msg sessions\``));
    assert.ok(routing.includes(`\`${INTERCOM_COMMAND} msg send <node> --new <runtime> --directive "<the operator's answer>"\``));
    assert.doesNotMatch(routing, /`msg (sessions|send)/);
  }
});

test("Claude and Codex carry the same intercom text", () => {
  const block = (text: string): string => {
    assert.ok(text.includes(INTERCOM_START) && text.includes(INTERCOM_END), "the intercom block is missing");
    return text.slice(text.indexOf(INTERCOM_START), text.indexOf(INTERCOM_END) + INTERCOM_END.length);
  };
  assert.equal(block(read("codex", "AGENTS.maestro.md")), block(read("claude", "CLAUDE.user.md")));
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { controlPlaneCli, renderControlPlaneRules } from "../../../codex/lib/control-plane-rules.mts";
import { nodePaths, type NodePaths } from "./config.mts";
import { checkIntercom } from "./doctor-intercom.mts";
import { instructionText, writeIntercomHost, type IntercomHost } from "./doctor-intercom-fixture.mts";
import { INTERCOM_INSTRUCTIONS, expectedIntercomText, launcherToken, renderIntercomInstructions } from "./intercom-instructions.mts";
import { launcherCommand } from "./launcher.mts";

// Issue #436. The intercom check against synthetic hosts: one healthy host,
// then one mutation at a time, each of which must fail with its own status.

interface Host extends IntercomHost { paths: NodePaths; claude: string; codex: string; scratch: string }

function host(t: test.TestContext, intercom = true): Host {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-doctor-intercom-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const paths = nodePaths(path.join(scratch, "config"));
  const claude = path.join(scratch, "claude");
  const codex = path.join(scratch, "codex");
  fs.mkdirSync(paths.dir, { recursive: true });
  const written = intercom ? writeIntercomHost(paths, claude, codex, scratch)
    : { root: path.dirname(paths.dir), pin: "", receipt: undefined as never, files: {} as IntercomHost["files"] };
  return { ...written, paths, claude, codex, scratch };
}

const check = (h: Host) => checkIntercom({ paths: h.paths, claudeConfigDir: h.claude, codexHome: h.codex });
const allPresent = Object.fromEntries(INTERCOM_INSTRUCTIONS.map((kind) => [kind, "present"]));
const bin = (h: Host, name: string) => path.join(h.root, "bin", name);
const shimNames = process.platform === "win32" ? ["posix", "cmd", "ps1"] : ["posix"];

test("a host whose receipt, launcher, pin and instruction files agree passes", (t) => {
  const h = host(t);
  assert.deepEqual(check(h), {
    ok: true, managed: true, receipt: "valid",
    launcher: { path: bin(h, "kherep-node.mjs"), status: "current" },
    shims: Object.fromEntries(shimNames.map((name) => [name, "current"])),
    resolves: "match", node: "present", instructions: allPresent,
  });
});

test("a node without a managed service reports managed false and fails", (t) => {
  const h = host(t, false);
  const result = check(h);
  assert.deepEqual([result.ok, result.managed, result.receipt], [false, false, "missing"]);
  assert.match(String(result.detail), /no managed service/);
});

test("an unreadable or invalid receipt fails as invalid", (t) => {
  const h = host(t);
  const receipt = path.join(h.paths.dir, "service", "receipt.json");
  fs.writeFileSync(receipt, "{");
  assert.deepEqual([check(h).ok, check(h).receipt, check(h).managed], [false, "invalid", true]);
  fs.writeFileSync(receipt, JSON.stringify({ ...h.receipt, binding: { ...h.receipt.binding, source: { ...h.receipt.binding.source, kind: "checkout" } } }));
  assert.equal(check(h).receipt, "invalid");
});

test("stale and missing launcher bytes fail with their own status", (t) => {
  const h = host(t);
  fs.appendFileSync(bin(h, "kherep-node.mjs"), "// edited\n");
  let result = check(h);
  assert.deepEqual([result.ok, (result.launcher as { status: string }).status, result.resolves], [false, "stale", "match"]);
  assert.match(String(result.detail), /launcher/);
  fs.rmSync(bin(h, "kherep-node.mjs"));
  result = check(h);
  assert.equal((result.launcher as { status: string }).status, "missing");
});

test("a stale or missing shim fails with its own status", (t) => {
  const h = host(t);
  fs.writeFileSync(bin(h, "kherep-node"), "#!/bin/sh\nexec node /elsewhere/kherep-node.mjs \"$@\"\n");
  let result = check(h);
  assert.deepEqual([result.ok, (result.shims as Record<string, string>).posix, (result.launcher as { status: string }).status],
    [false, "stale", "current"]);
  fs.rmSync(bin(h, "kherep-node"));
  result = check(h);
  assert.equal((result.shims as Record<string, string>).posix, "missing");
});

test("a removed pin, a pin without the CLI and a pin that does not verify fail with their own status", (t) => {
  let h = host(t);
  fs.rmSync(path.join(h.pin, "modules", "control-plane", "node", "cli.mts"));
  assert.deepEqual([check(h).ok, check(h).resolves], [false, "missing-cli"]);
  fs.rmSync(h.pin, { recursive: true, force: true });
  assert.deepEqual([check(h).ok, check(h).resolves], [false, "missing-pin"]);

  h = host(t);
  fs.writeFileSync(path.join(h.paths.dir, "service", "receipt.json"), JSON.stringify({ ...h.receipt,
    binding: { ...h.receipt.binding, source: { ...h.receipt.binding.source, digest: "e".repeat(64) } } }));
  let result = check(h);
  assert.deepEqual([result.ok, result.receipt, result.resolves], [false, "valid", "mismatch"]);
  assert.match(String(result.detail), /pin/);

  h = host(t);
  fs.writeFileSync(path.join(h.pin, "package.json"), "{\"tampered\":true}\n");
  result = check(h);
  assert.deepEqual([result.ok, result.resolves], [false, "mismatch"]);
});

test("a receipt whose Node executable is gone fails as node missing", (t) => {
  const h = host(t);
  const gone = path.join(h.scratch, "no-such-node", process.platform === "win32" ? "node.exe" : "node");
  fs.writeFileSync(path.join(h.paths.dir, "service", "receipt.json"), JSON.stringify({ ...h.receipt,
    binding: { ...h.receipt.binding, nodeExecutable: gone } }));
  const result = check(h);
  assert.deepEqual([result.ok, result.node, result.resolves, (result.launcher as { status: string }).status],
    [false, "missing", "match", "current"]);
});

test("each instruction file is reported stale, missing or unreadable on its own", (t) => {
  for (const kind of INTERCOM_INSTRUCTIONS) {
    const h = host(t);
    fs.writeFileSync(h.files[kind], "# Operator text without the intercom command\n");
    let result = check(h);
    assert.deepEqual([result.ok, result.instructions], [false, { ...allPresent, [kind]: "stale" }], kind);
    assert.match(String(result.detail), /instruction file/);
    fs.rmSync(h.files[kind]);
    result = check(h);
    assert.deepEqual(result.instructions, { ...allPresent, [kind]: "missing" }, kind);
    fs.mkdirSync(h.files[kind]);
    assert.deepEqual(check(h).instructions, { ...allPresent, [kind]: "unreadable" }, kind);
  }
});

test("a rules file that allowlists only the legacy pin CLI is stale", (t) => {
  const h = host(t);
  fs.writeFileSync(h.files.codexRules, renderControlPlaneRules(controlPlaneCli(h.pin)));
  assert.deepEqual([check(h).ok, (check(h).instructions as Record<string, string>).codexRules], [false, "stale"]);
  fs.writeFileSync(h.files.codexRules, renderControlPlaneRules(controlPlaneCli(h.pin))
    + renderControlPlaneRules(launcherToken(h.root)));
  assert.equal((check(h).instructions as Record<string, string>).codexRules, "present");
});

test("an unrendered placeholder in an instruction file is stale", (t) => {
  const h = host(t);
  fs.writeFileSync(h.files.claudeUser, "__KHEREP_NODE__ msg sessions\n");
  assert.equal((check(h).instructions as Record<string, string>).claudeUser, "stale");
});

test("the report holds paths and fixed statuses, never file contents", (t) => {
  const h = host(t);
  for (const kind of INTERCOM_INSTRUCTIONS) fs.appendFileSync(h.files[kind], "\nSYNTHETIC_SECRET token=SYNTHETIC_TOKEN\n");
  fs.mkdirSync(h.paths.inbox, { recursive: true });
  fs.writeFileSync(path.join(h.paths.inbox, "m.json"), JSON.stringify({ text: "SYNTHETIC_MESSAGE_BODY" }));
  const text = JSON.stringify(check(h));
  for (const value of ["SYNTHETIC_SECRET", "SYNTHETIC_TOKEN", "SYNTHETIC_MESSAGE_BODY", h.receipt.binding.source.digest,
    h.receipt.binding.source.commit, "Operator text"]) assert.equal(text.includes(value), false, value);
});

test("the expected text is the launcher command, and the rules pattern its quoted path", (t) => {
  const h = host(t);
  for (const kind of INTERCOM_INSTRUCTIONS) assert.ok(instructionText(kind, h.root).includes(expectedIntercomText(kind, h.root)), kind);
  assert.equal(expectedIntercomText("claudeUser", h.root), launcherCommand(h.root));
  assert.ok(expectedIntercomText("codexRules", h.root).includes(JSON.stringify(launcherToken(h.root))));
  assert.equal(`node "${launcherToken(h.root)}"`, launcherCommand(h.root));
  assert.equal(renderIntercomInstructions("a __KHEREP_NODE__ b __KHEREP_NODE__", h.root),
    `a ${launcherCommand(h.root)} b ${launcherCommand(h.root)}`);
  const win = "C:\\Users\\Synthetic\\AppData\\Roaming\\kherep";
  assert.equal(expectedIntercomText("codexAgents", win, "win32"), 'node "C:/Users/Synthetic/AppData/Roaming/kherep/bin/kherep-node.mjs"');
  assert.match(expectedIntercomText("codexRules", win, "win32"), /^pattern = \["node", "C:\/Users\/Synthetic\/AppData\/Roaming\/kherep\/bin\/kherep-node\.mjs", "msg", \[/);
});

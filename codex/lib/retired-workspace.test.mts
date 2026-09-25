import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { InstallTransaction } from "./install-transaction.mts";
import { foldedSha256, parseRetiredManifest, retireWorkspaceEntries } from "./retired-workspace.mts";

// #44. The Codex side of bootstrap/install-transaction.test.sh test_retire and
// test_retire_declared: same manifest format, same outcome for the same files.
const sha = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");
const KNOWN = sha("ws-known\n");
const OTHER = sha("another placed version\n");

function workspaceFixture(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-codex-retire-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const backup = path.join(root, "backup");
  const write = (relative: string, content: string): string => {
    const file = path.join(workspace, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  return { root, workspace, backup, write, transaction: new InstallTransaction(workspace, backup) };
}

test("reads only project/ entries and refuses an invalid manifest as a whole", () => {
  const entries = parseRetiredManifest([
    "# comment", "", "hooks/em-dash-watch.js", `project/tools/a.mjs sha256:${KNOWN},${OTHER}\r`,
  ].join("\n"));
  assert.deepEqual(entries, [{ entry: "project/tools/a.mjs", relative: "tools/a.mjs", hashes: [KNOWN, OTHER] }]);
  assert.throws(() => parseRetiredManifest(`project/tools/a.mjs sha256:${KNOWN}\nproject/tools/b.mjs\n`),
    /retirement manifest entry project\/tools\/b\.mjs needs 'sha256:<hex>\[,<hex>\.\.\.\]'/);
  assert.throws(() => parseRetiredManifest(`project/tools/b.mjs sha256:${KNOWN.toUpperCase()}\n`), /needs 'sha256:/);
  assert.throws(() => parseRetiredManifest(`hooks/x.js sha256:${KNOWN}\n`), /Claude-home entry and takes no hashes/);
  for (const bad of ["/etc/x", "project/../x", "project/./x", "project\\x", "project/tools/", ".."]) {
    assert.throws(() => parseRetiredManifest(`${bad} sha256:${KNOWN}\n`), /strict traversal-free relative path/, bad);
  }
});

test("hashes content with CRLF folded to LF", (t) => {
  const { write } = workspaceFixture(t);
  assert.equal(foldedSha256(write("lf", "ws-known\n")), KNOWN);
  assert.equal(foldedSha256(write("crlf", "ws-known\r\n")), KNOWN);
});

test("parks known content with a backup, keeps unknown content and skips an absent entry", (t) => {
  const { workspace, backup, write, transaction } = workspaceFixture(t);
  const known = write("tools/mpac/mpac.ps1", "ws-known\r\n");
  const edited = write("tools/edited/tool.ps1", "operator edit\n");
  const lines: string[] = [];
  retireWorkspaceEntries(parseRetiredManifest([
    `project/tools/edited/tool.ps1 sha256:${KNOWN},${OTHER}`,
    `project/tools/mpac/README.md sha256:${KNOWN}`,
    `project/tools/mpac/mpac.ps1 sha256:${OTHER},${KNOWN}`,
  ].join("\n")), workspace, transaction, (line) => lines.push(line));

  assert.equal(fs.existsSync(known), false);
  assert.equal(fs.readFileSync(path.join(workspace, "tools", "mpac", "_deprecated", "mpac.ps1"), "utf8"), "ws-known\r\n");
  assert.equal(fs.readFileSync(path.join(backup, "tools", "mpac", "mpac.ps1"), "utf8"), "ws-known\r\n");
  assert.deepEqual(lines.filter((line) => line.startsWith("retire: KEEP")),
    ["retire: KEEP project/tools/edited/tool.ps1 (content not placed by the installer)"]);
  assert.equal(fs.readFileSync(edited, "utf8"), "operator edit\n");
  assert.equal(fs.existsSync(path.join(workspace, "tools", "edited", "_deprecated")), false);
  assert.equal(fs.existsSync(path.join(backup, "tools", "edited")), false);
  assert.ok(lines.some((line) => line.startsWith("retire: SKIP project/tools/mpac/README.md (nothing at ")));
  assert.deepEqual(transaction.targets(), [known]);

  transaction.rollback();
  assert.equal(fs.readFileSync(known, "utf8"), "ws-known\r\n");
  assert.equal(fs.readFileSync(path.join(workspace, "tools", "mpac", "_deprecated", "mpac.ps1"), "utf8"), "ws-known\r\n");
});

test("a second retirement gets a dated sibling and never overwrites a parked file", (t) => {
  const { workspace, write, transaction } = workspaceFixture(t);
  const graveyard = path.join(workspace, "hooks", "_deprecated");
  write("hooks/_deprecated/x.js", "first");
  write("hooks/_deprecated/x.js.19700101-000000", "second");
  const live = write("hooks/x.js", "third");
  assert.equal(transaction.park(live, "19700101-000000"), path.join(graveyard, "x.js.19700101-000000-1"));
  assert.equal(fs.readFileSync(path.join(graveyard, "x.js"), "utf8"), "first");
  assert.equal(fs.readFileSync(path.join(graveyard, "x.js.19700101-000000"), "utf8"), "second");
  assert.equal(fs.readFileSync(path.join(graveyard, "x.js.19700101-000000-1"), "utf8"), "third");
  const again = write("hooks/y.js", "fourth");
  write("hooks/_deprecated/y.js", "parked");
  assert.match(path.basename(transaction.park(again)), /^y\.js\.\d{8}-\d{6}$/);
});

test("rollback removes a _deprecated/ it created while that is still empty", (t) => {
  const { workspace, write, transaction } = workspaceFixture(t);
  const live = write("tools/x/tool.ps1", "fresh");
  t.mock.method(fs, "renameSync", () => { throw new Error("fixture rename failure"); });
  assert.throws(() => transaction.park(live), /fixture rename failure/);
  t.mock.restoreAll();
  transaction.rollback();
  assert.equal(fs.readFileSync(live, "utf8"), "fresh");
  assert.equal(fs.existsSync(path.join(workspace, "tools", "x", "_deprecated")), false);
});

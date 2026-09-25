// OP-1432. The observation agent definition is loaded by two runtimes, and on
// 2026-09-24 the Claude one followed the Codex worker branch (returned a JSON
// candidate, wrote nothing) and once picked the Codex broker. Each runtime now
// gets its own text; this test pins what each one is allowed to say.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { renderAgent } from "../codex/lib/component-render.mts";
import type { Capabilities } from "../codex/lib/contracts.mts";
import { agentSourcePath } from "../codex/lib/parity-projection.mts";

const REPO = path.resolve(import.meta.dirname, "..");
const CLAUDE_OBS = fs.readFileSync(path.join(REPO, "claude", "agents", "claude-obs.md"), "utf8");
const capabilities = JSON.parse(
  fs.readFileSync(path.join(REPO, "codex", "parity", "capabilities.json"), "utf8"),
) as Capabilities;

function codexProjection(): string {
  const options = capabilities.agents["claude-obs"];
  const source = fs.readFileSync(agentSourcePath(REPO, "claude-obs", options), "utf8");
  const toml = renderAgent(options.as || "claude-obs", source, options);
  const line = toml.split("\n").find((entry) => entry.startsWith("developer_instructions = "))!;
  return JSON.parse(line.slice("developer_instructions = ".length)) as string;
}

test("the Claude text names exactly the ccoder broker invocation", () => {
  assert.match(CLAUDE_OBS, /<confluence\.json broker> <verb>/);
  for (const verb of ["related", "create", "stitch", "children"]) {
    assert.match(CLAUDE_OBS, new RegExp(`^ +<confluence\\.json broker> ${verb} `, "m"), verb);
  }
  assert.match(CLAUDE_OBS, /`broker`[\s\S]{0,300}atl-confluence-ccoder\.mts/);
  assert.doesNotMatch(CLAUDE_OBS, /<broker>/, "a placeholder broker name lets the model pick one");
});

// Issue #13. The installed text kept a literal <workspace>, the model guessed
// the checkout instead of the workspace root and reported a missing broker.
test("the Claude text takes the broker only from confluence.json, verbatim", () => {
  assert.doesNotMatch(CLAUDE_OBS, /<workspace>/);
  const composed = CLAUDE_OBS.split(/\r?\n/).filter((line) => /^ {4}node /.test(line));
  assert.deepEqual(composed, [], "a command line composes the broker itself");
  assert.match(CLAUDE_OBS, /exactly as stored/i);
  assert.match(CLAUDE_OBS, /never derive[\s\S]{0,200}working\s+directory[\s\S]{0,200}repository/i);
  assert.match(CLAUDE_OBS, /`OBS-RESULT: failed missing broker <[^>]*path[^>]*>`/);
  // The installer writes broker on every install and the space only once it
  // resolved, so a file with broker alone is a host without a space.
  assert.match(CLAUDE_OBS, /`broker` but no\s+`spaceKey`[\s\S]{0,120}`OBS-RESULT: failed no space configured`/);
});

test("the Claude text mentions the Codex broker only to prohibit it", () => {
  const lines = CLAUDE_OBS.split(/\r?\n/).filter((line) => line.includes("atl-confluence.mts"));
  assert.ok(lines.length >= 1, "the prohibition of atl-confluence.mts is missing");
  for (const line of lines) assert.match(line, /\bnever\b|\bnot\b/i, line);
  assert.doesNotMatch(CLAUDE_OBS, /KHEREP_ATL_CRED_FILE_CODEX/);
});

test("the Claude text carries no Codex worker mode", () => {
  for (const forbidden of [
    /candidate-only/i, /one strict JSON document/i, /"observations"/, /bodyStorage/,
    /perform(?:s)? no configuration or broker I\/O/i, /observationPublishingAuthorized/, /running as Codex/i,
  ]) {
    assert.doesNotMatch(CLAUDE_OBS, forbidden, String(forbidden));
  }
});

test("the Claude text defines the one status line and when each status applies", () => {
  assert.match(CLAUDE_OBS, /`OBS-RESULT: wrote <n> <page ids>`/);
  assert.match(CLAUDE_OBS, /`OBS-RESULT: empty <reason>`/);
  assert.match(CLAUDE_OBS, /`OBS-RESULT: failed <reason>`/);
  assert.match(CLAUDE_OBS, /first line[\s\S]{0,200}exactly one/i);
  assert.match(CLAUDE_OBS, /missing broker, missing credential[\s\S]{0,200}`failed`, never `empty`/);
  assert.match(CLAUDE_OBS, /title states the finding as it stands/i);
});

test("the Claude text files under a node the brief names", () => {
  assert.match(CLAUDE_OBS, /brief names a node[\s\S]{0,300}you use it/i);
  assert.match(CLAUDE_OBS, /unresolved scope[\s\S]{0,200}only when/i);
});

// OP-1436. With the broker removed, a run searched the workspace for another
// copy; a brief without a session id got an invented session label; a work
// item describing an earlier measurement was filed as confirmed.
test("the Claude text checks one broker path and never searches for another copy", () => {
  assert.match(CLAUDE_OBS, /check exactly that one path[\s\S]{0,300}never search/i);
});

test("the Claude text takes the session label only from the brief", () => {
  assert.match(CLAUDE_OBS, /session id[\s\S]{0,200}only from the brief/i);
  assert.match(CLAUDE_OBS, /brief gives no session id[\s\S]{0,200}leave the\s+session label out/i);
});

test("both texts treat a second-hand measurement as assumed", () => {
  for (const text of [CLAUDE_OBS, codexProjection()]) {
    assert.match(text, /second-hand[\s\S]{0,300}`assumed`/i);
  }
});

// OP-1437. A brief headed "Scope: Kherep" got two of three pages placed by
// content instead. The named node now binds every finding of the run.
test("the Claude text binds every finding to the node the brief names", () => {
  assert.match(CLAUDE_OBS, /`Scope: <node>`[\s\S]{0,200}names the node/);
  assert.match(CLAUDE_OBS, /every finding[\s\S]{0,200}content/i);
  assert.match(CLAUDE_OBS, /before each `create`[\s\S]{0,200}`--parent`/i);
});

test("both routing files let a node named in the brief override the content", () => {
  for (const file of [path.join(REPO, "claude", "teams", "kherep", "ROUTING.md"), path.join(REPO, "codex", "ROUTING.md")]) {
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /node named in the brief[\s\S]{0,200}every finding/i, file);
  }
});

test("the Codex projection keeps its own worker contract and no Claude broker", () => {
  const options = capabilities.agents["claude-obs"];
  assert.equal(options.as, "codex-obs");
  assert.equal(options.source, "codex/agents/codex-obs.md");
  const text = codexProjection();
  assert.match(text, /## Codex candidate-only mode\n/);
  assert.match(text, /Codex worker performs no configuration or broker I\/O/);
  assert.match(text, /Codex.*one strict JSON document/s);
  assert.match(text, /trusted Maestro main thread is the Codex publisher/);
  assert.doesNotMatch(text, /atl-confluence-ccoder|OBS-RESULT|KHEREP_ATL_CRED_FILE_CLAUDE/);
});

test("both routing files treat OBS-RESULT: failed as a failure, not an empty result", () => {
  for (const file of [path.join(REPO, "claude", "teams", "kherep", "ROUTING.md"), path.join(REPO, "codex", "ROUTING.md")]) {
    const text = fs.readFileSync(file, "utf8");
    const section = text.slice(text.indexOf("## Session observations"), text.indexOf("## Linking"));
    assert.match(section, /`OBS-RESULT: failed[^`]*`[\s\S]{0,200}same turn/, file);
    assert.match(section, /never[\s\S]{0,40}valid empty result/, file);
  }
});

test("both definitions stay under the size cap", () => {
  for (const file of [
    path.join(REPO, "claude", "agents", "claude-obs.md"),
    path.join(REPO, "codex", "agents", "codex-obs.md"),
    import.meta.filename,
  ]) {
    const lines = fs.readFileSync(file, "utf8").replace(/\n$/, "").split(/\r?\n/).length;
    assert.ok(lines <= 250, `${path.basename(file)} is ${lines} lines`);
  }
});

// Guards the Windows CI shard map in ci-shard.mts (issue #424).
//
// The ruleset requires the check "unit (windows-latest)". Windows runs the
// bootstrap suites split across the unit-windows matrix, and a gate job carries
// that check name. Coverage holds only while three things agree: the shard map,
// the bootstrap/*.test.mts population, and the suite list and gate in ci.yml.
// The matrix also carries the hooks, control-plane and codex suites (codex runs
// `npm run test:codex`, issue #534); they are not in the shard map.
// The workflow is scanned as plain text; the repository has no YAML parser and
// this guard does not need one.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { NAMED, REST, SHARDS, filesFor } from "./ci-shard.mts";

const repo = path.resolve(import.meta.dirname, "..");
const bootstrap = path.join(repo, "bootstrap");
const workflow = fs.readFileSync(path.join(repo, ".github", "workflows", "ci.yml"), "utf8").replace(/\r\n/g, "\n");
const SELF = path.basename(import.meta.filename);

// The glob population of `node --test "bootstrap/*.test.mts"`, read here
// rather than through the module under test.
const population = fs.readdirSync(bootstrap, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mts"))
  .map((entry) => entry.name)
  .sort();

// The body of one top-level job, up to the next job key.
function jobBlock(id: string): string {
  const start = workflow.indexOf(`\n  ${id}:\n`);
  assert.ok(start >= 0, `ci.yml has no job "${id}"`);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n {2}\S/);
  return next < 0 ? rest : rest.slice(0, next);
}

test("every named shard file exists under bootstrap/", () => {
  for (const [shard, files] of Object.entries(NAMED)) {
    assert.ok(files.length > 0, `shard ${shard} names no file`);
    for (const file of files) {
      assert.ok(fs.existsSync(path.join(bootstrap, file)), `shard ${shard} names missing file bootstrap/${file}`);
    }
  }
});

test("no test file belongs to two shards", () => {
  const owner = new Map<string, string>();
  for (const shard of SHARDS) {
    for (const file of filesFor(shard)) {
      assert.equal(owner.get(file), undefined, `bootstrap/${file} is in shard ${owner.get(file)} and ${shard}`);
      owner.set(file, shard);
    }
  }
});

test("the shards together cover bootstrap/*.test.mts exactly", () => {
  const union = SHARDS.flatMap((shard) => filesFor(shard)).sort();
  assert.deepEqual(union, population);
  assert.ok(filesFor(REST).includes(SELF), `${REST} does not run ${SELF}`);
});

test("the unit-windows suite list in ci.yml names every shard and nothing else", () => {
  const lists = [...jobBlock("unit-windows").matchAll(/^ +suite: *\[([^\]]*)\]/gm)];
  assert.equal(lists.length, 1, "unit-windows needs exactly one `suite: [...]` flow sequence");
  const suites = lists[0][1].split(",").map((item) => item.trim()).filter(Boolean);
  assert.equal(new Set(suites).size, suites.length, `duplicate suite in ci.yml: ${suites.join(", ")}`);
  assert.deepEqual([...suites].sort(), ["codex", "control-plane", "hooks", ...SHARDS].sort());
});

test("the unit-windows-gate job is the required check and runs after every shard", () => {
  const gate = jobBlock("unit-windows-gate");
  assert.match(gate, /^ {4}name: unit \(windows-latest\)$/m);
  assert.match(gate, /^ {4}needs: unit-windows$/m);
  assert.match(gate, /^ {4}if: always\(\)$/m);
});

test("the CLI lists the shards and refuses an unknown one by name", () => {
  const cli = path.join(bootstrap, "ci-shard.mts");
  const list = spawnSync(process.execPath, [cli, "list"], { encoding: "utf8" });
  assert.equal(list.status, 0, list.stderr);
  assert.deepEqual(list.stdout.trim().split(/\r?\n/), SHARDS);
  const unknown = spawnSync(process.execPath, [cli, "run", "no-such-shard"], { encoding: "utf8" });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /no-such-shard/);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { loadTypeScriptConvention } from "./typescript-convention.mts";
import { FIXTURE_MODULE, outputFixture } from "./typescript-output-proof-fixture.mts";

const load = (root: string) => loadTypeScriptConvention(root, {}, [FIXTURE_MODULE]);

test("verified compiler output is removed from the authored JavaScript population", (t) => {
  const fixture = outputFixture(t);
  const state = load(fixture.root);
  assert.deepEqual(state.unlisted, []);
  assert.equal(state.onDisk.some((file) => file.includes("/dist/")), false);
});

test("adding altered generated output to the legacy inventory cannot bypass proof", (t) => {
  const fixture = outputFixture(t);
  fixture.writeOutput("src/value.js", "hand authored\n");
  fixture.writeInventory(["modules/compiled-example/dist/src/value.js"]);
  assert.throws(() => load(fixture.root), /altered generated output/);
});

test("adding extra dist output to the legacy inventory cannot bypass proof", (t) => {
  const fixture = outputFixture(t);
  fixture.writeOutput("src/extra.js", "hand authored\n");
  fixture.writeInventory(["modules/compiled-example/dist/src/extra.js"]);
  assert.throws(() => load(fixture.root), /unexpected generated output/);
});

test("a Git-free source archive still enforces authored JavaScript", (t) => {
  const fixture = outputFixture(t, { compiler: false, output: false });
  fs.writeFileSync(path.join(fixture.root, "authored.mts"), "export {};\n");
  fs.writeFileSync(path.join(fixture.root, "authored.js"), "export {};\n");
  const state = load(fixture.root);
  assert.equal(fs.existsSync(path.join(fixture.root, ".git")), false);
  assert.deepEqual(state.unlisted, ["authored.js"]);
});

test("legacy inventory remains bidirectional", (t) => {
  const fixture = outputFixture(t, { compiler: false, output: false });
  fs.writeFileSync(path.join(fixture.root, "legacy.js"), "module.exports = 1;\n");
  fixture.writeInventory(["gone.js", "legacy.js"]);
  const state = load(fixture.root);
  assert.deepEqual(state.unlisted, []);
  assert.deepEqual(state.stale, ["gone.js"]);
});

test("existing repository exclusions remain bidirectional and unchanged", (t) => {
  const fixture = outputFixture(t, { compiler: false, output: false });
  for (const relative of [
    "_deprecated/old.js",
    "node_modules/vendor.js",
    ".hook-adapter-case/runtime.js",
    "codex/parity/plugin-sources/vendor.js",
  ]) {
    const file = path.join(fixture.root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "ignored\n");
  }
  const state = load(fixture.root);
  assert.deepEqual(state.onDisk, []);
  assert.deepEqual(state.unlisted, []);
});

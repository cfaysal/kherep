#!/usr/bin/env node
// Unit test for hook-inventory.mts: which specifiers count as a runtime import,
// and how the walk resolves, bounds and dedupes them. Pure strings and an
// in-memory source map, no file system; the contract test
// live-hook-integrity-imports.test.mts drives the same code through the hook.
// Runs on its own as `node hook-inventory.test.mts`, like every suite in CI.

import assert from "node:assert/strict";
import { test } from "node:test";

import { hookInventory, relativeSpecifiers, wiredFiles, type HookFile } from "./hook-inventory.mts";

const HOOKS = "/home/example/.claude/hooks";

// Fixture sources spell `from` through this helper, so the literal text of this
// file holds no relative from-clause: bootstrap/hook-require-resolution.test.mts scans
// every hook file for exactly that and would read a fixture as a real import.
const from = (specifier: string, quote = '"'): string => `from ${quote}${specifier}${quote}`;

// A source map keyed by absolute path; a missing key reads as "nothing there".
function reader(sources: Record<string, string>, calls: string[] = []) {
  return (file: string): string | null => {
    calls.push(file);
    return sources[file] ?? null;
  };
}

const root = (rel: string): HookFile => ({ file: `${HOOKS}/${rel}`, rel });

test("collects every runtime import form, in single and double quotes", () => {
  const source = [
    `import fs from "node:fs";`,
    `import { a } ${from("./lib/a.mts", "'")};`,
    `import {`,
    `  b,`,
    `  type B, // inline type: the module still loads`,
    `} ${from("./lib/b.mts")};`,
    `export { c } ${from("./lib/c.mts")};`,
    `import "./lib/side-effect.mts";`,
    `import * as d ${from("./lib/d.js")};`,
  ].join("\n");
  assert.deepEqual(relativeSpecifiers(source).sort(), [
    "./lib/a.mts", "./lib/b.mts", "./lib/c.mts", "./lib/d.js", "./lib/side-effect.mts",
  ]);
});

test("skips type-only statements, comments, non-relative and extension-less specifiers", () => {
  const source = [
    `import type { T } ${from("./lib/types-only.mts")};`,
    `export type { U } ${from("./lib/types-too.mts")};`,
    `// import { ghost } ${from("./lib/ghost.mts")};`,
    `/* import { ghost2 } ${from("./lib/ghost2.mts")}; */`,
    `/**`,
    `import { ghost3 } ${from("./lib/ghost3.mts")};`,
    ` */`,
    `import os from "os";`,
    `import abs from "/abs/x.mts";`,
    `import bare ${from("./lib/no-extension")};`,
    `import data ${from("./lib/data.json")};`,
  ].join("\n");
  assert.deepEqual(relativeSpecifiers(source), []);
});

test("a /* or // inside a string does not swallow the imports after it", () => {
  const source = `const glob = "hooks/*.mts"; const url = "http://example.test";\nimport { a } ${from("./lib/a.mts")};\n// */`;
  assert.deepEqual(relativeSpecifiers(source), ["./lib/a.mts"]);
});

test("a block comment right after ) or } is stripped too", () => {
  const source = `run()/* old wiring:\nimport { g } ${from("./lib/ghost.mts")};\n*/\nconst o = {}/*\nimport { h } ${from("./lib/ghost2.mts")};\n*/;`;
  assert.deepEqual(relativeSpecifiers(source), []);
});

test("a default import named type is a runtime import", () => {
  assert.deepEqual(relativeSpecifiers(`import type ${from("./lib/t.mts")};`), ["./lib/t.mts"]);
});

test("walks transitively and names every importer", () => {
  const inventory = hookInventory([root("guard.mts"), root("other.mts")], HOOKS, reader({
    [`${HOOKS}/guard.mts`]: `import { a } ${from("./lib/a.mts")};\nimport { p } ${from("./pairs.mts")};`,
    [`${HOOKS}/other.mts`]: `import { b } ${from("./lib/b.mts")};`,
    [`${HOOKS}/lib/a.mts`]: `import { b } ${from("./b.mts")};`,
    [`${HOOKS}/lib/b.mts`]: `export const b = 1;`,
  }));
  const byRel = Object.fromEntries(inventory.map((entry) => [entry.rel, entry]));
  assert.deepEqual(Object.keys(byRel).sort(), ["guard.mts", "lib/a.mts", "lib/b.mts", "other.mts", "pairs.mts"]);
  assert.equal(byRel["guard.mts"].wired, true);
  assert.equal(byRel["lib/b.mts"].wired, false);
  assert.deepEqual(byRel["lib/b.mts"].importedBy.sort(), ["lib/a.mts", "other.mts"]);
  assert.deepEqual(byRel["pairs.mts"].importedBy, ["guard.mts"]);
});

test("an in-bounds .. from lib/ and a direct import of the same file give one entry", () => {
  const inventory = hookInventory([root("guard.mts")], HOOKS, reader({
    [`${HOOKS}/guard.mts`]: `import { a } ${from("./lib/a.mts")};\nimport { s } ${from("./shared.mts")};`,
    [`${HOOKS}/lib/a.mts`]: `import { s } ${from("../shared.mts")};`,
  }));
  const shared = inventory.filter((entry) => entry.rel.endsWith("shared.mts"));
  assert.deepEqual(shared.map((entry) => entry.rel), ["shared.mts"]);
  assert.deepEqual(shared[0].importedBy.sort(), ["guard.mts", "lib/a.mts"]);
});

test("drops targets outside the hooks directory, including through ..", () => {
  const inventory = hookInventory([root("guard.mts")], HOOKS, reader({
    [`${HOOKS}/guard.mts`]: `import a ${from("../outside.mts")};\nimport b ${from("./lib/../../x.mts")};\nimport c ${from("./lib/../in.mts")};`,
  }));
  assert.deepEqual(inventory.map((entry) => entry.rel).sort(), ["guard.mts", "in.mts"]);
});

test("dedupes case-insensitively and ends a cycle", () => {
  const calls: string[] = [];
  const inventory = hookInventory([root("guard.mts"), root("GUARD.mts")], HOOKS, reader({
    [`${HOOKS}/guard.mts`]: `import { a } ${from("./lib/a.mts")};\nimport { A } ${from("./LIB/A.mts")};`,
    [`${HOOKS}/lib/a.mts`]: `import { b } ${from("./b.mts")};`,
    [`${HOOKS}/lib/b.mts`]: `import { a } ${from("./a.mts")};`,
  }, calls));
  assert.deepEqual(inventory.map((entry) => entry.rel).sort(), ["guard.mts", "lib/a.mts", "lib/b.mts"]);
  assert.equal(calls.length, 3, "every file is read once");
  const a = inventory.find((entry) => entry.rel === "lib/a.mts");
  assert.deepEqual(a && a.importedBy.sort(), ["guard.mts", "lib/b.mts"]);
});

test("a file the reader cannot supply stays in the inventory, the walk just stops there", () => {
  const inventory = hookInventory([root("guard.mts")], HOOKS, reader({
    [`${HOOKS}/guard.mts`]: `import { a } ${from("./lib/a.mts")};`,
  }));
  assert.deepEqual(inventory.map((entry) => entry.rel), ["guard.mts", "lib/a.mts"]);
});

test("wiredFiles reads through the supplied reader and ignores tokens that are no hook file", () => {
  const home = "/home/example/.claude";
  const settings = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [
    { type: "command", command: `& node "${home}/hooks/guard.mts"` },
    { type: "command", command: `node ${home}/kherep/outside.mts` },
  ] }] } });
  const missing = Object.assign(new Error("absent"), { code: "ENOENT" });
  const { files, notes, readAny } = wiredFiles(home, (name) => {
    if (name === "settings.user.json") return settings;
    throw missing;
  });
  assert.deepEqual(files, [{ file: `${home}/hooks/guard.mts`, rel: "guard.mts" }]);
  assert.deepEqual(notes, []);
  assert.equal(readAny, true);
});

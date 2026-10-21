// Issue #533. The Codex hook adapter and hook-integrity hook are split into modules
// below the line budget. A module both adapter copies import must be installed and
// restorable under its own name, or a lone entry copy would fail at import.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { relativeSpecifiers } from "../../claude/hooks/lib/hook-inventory.mts";
import * as adapter from "./hook-adapter.mts";
import { ADAPTER_MODULES } from "./hook-adapter.fixture.mts";
import { sourceOf } from "./hook-integrity-sources.mts";

const HERE = import.meta.dirname;
const REPO = path.resolve(HERE, "..", "..");
const INTEGRITY_MODULES = ["hook-integrity-repair.mts", "hook-integrity-sources.mts"];
const lines = (file: string): number => fs.readFileSync(file, "utf8").split("\n").length - 1;
const text = (name: string): string => fs.readFileSync(path.join(HERE, name), "utf8");

test("the adapter entry imports exactly its three modules from its own directory", () => {
  assert.deepEqual([...ADAPTER_MODULES].sort(), ["hook-adapter-payload.mts", "hook-adapter-run.mts", "hook-adapter-verdict.mts"]);
});

test("every file the split creates is at or below 250 lines", () => {
  const files = ["hook-adapter.mts", ...ADAPTER_MODULES, "hook-adapter.fixture.mts", "hook-integrity.mts", ...INTEGRITY_MODULES,
    "hook-adapter-modules.test.mts", "hook-adapter-broken-module.test.mts", path.join("..", "hook-integrity-install-modules.test.mts")];
  for (const name of files) assert.ok(lines(path.join(HERE, name)) <= 250, `${name}: ${lines(path.join(HERE, name))} lines`);
});

test("every module is restorable from codex/hooks and copied by the installer under its own name", () => {
  const installer = fs.readFileSync(path.join(REPO, "codex", "install.mts"), "utf8");
  for (const name of [...ADAPTER_MODULES, ...INTEGRITY_MODULES]) {
    assert.deepEqual(sourceOf(`kherep-maestro/${name}`), { from: `codex/hooks/${name}` }, name);
    assert.ok(fs.existsSync(path.join(REPO, "codex", "hooks", name)), name);
    assert.ok(installer.includes(`path.join(targets.hookDir, "${name}"))`), `codex/install.mts copies ${name}`);
  }
});

// Issue #533 P1: the Claude-side integrity-verdict.mts exports restore and journal too; the
// own modules load into a namespace of their own, so main never reads them from lib.
test("hook-integrity.mts reads no lib.restore or lib.journal, and its own modules import only node:*", () => {
  const main = text("hook-integrity.mts");
  assert.doesNotMatch(main, /\blib\.restore\b/);
  assert.doesNotMatch(main, /\blib\.journal\b/);
  assert.match(main, /\(\) => import\("\.\/hook-integrity-repair\.mts"\)[\s\S]*\(\) => import\("\.\/hook-integrity-sources\.mts"\)/, "repair loads before sources");
  for (const name of [...INTEGRITY_MODULES, "hook-adapter-payload.mts", "hook-adapter-verdict.mts"]) {
    const imports = [...text(name).matchAll(/^import\b(?!\s+type\b)[^;]*?from\s*"([^"]+)"/gm)].map((match) => match[1]);
    assert.ok(imports.every((specifier) => specifier.startsWith("node:")), `${name}: ${imports.join(", ")}`);
    assert.deepEqual(relativeSpecifiers(text(name)), [], `${name} loads no relative module`);
  }
});

test("the entry re-exports the payload and runner functions its importers use", () => {
  for (const name of ["inputText", "normalizePayloads", "patchPaths", "shellCommandsFromExec", "normalizeDeployApproval", "budgetFor", "runAdaptedHook"]) {
    assert.equal(typeof Reflect.get(adapter, name), "function", name);
  }
});

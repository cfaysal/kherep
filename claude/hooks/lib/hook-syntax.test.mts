#!/usr/bin/env node
// Unit test for hook-syntax.mts (issue #278). Pure strings into syntaxVerdict,
// except where Node itself needs a file: the .js confirmation, the CLI and the
// stderr check, which use one mkdtemp directory. Runs on its own as
// `node hook-syntax.test.mts`, like every suite in CI.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";

import { esmParses, syntaxVerdict, type SyntaxVerdict } from "./hook-syntax.mts";

const LIB = path.join(import.meta.dirname, "hook-syntax.mts");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hook-syntax-"));
after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

// Fixture sources spell `from` through this helper, so the literal text of this
// file holds no relative from-clause: bootstrap/hook-require-resolution.test.mts scans
// every hook file for exactly that and would read a fixture as a real import.
const from = (specifier: string): string => `from "${specifier}"`;

const detailOf = (v: SyntaxVerdict): string => (v.state === "OK" ? "" : v.detail);

async function expectDefekt(name: string, source: string, needle: string): Promise<void> {
  const v = await syntaxVerdict(name, source);
  assert.equal(v.state, "DEFEKT", `${JSON.stringify(source)}: ${detailOf(v)}`);
  assert.ok(detailOf(v).includes(needle), `${JSON.stringify(source)}: ${detailOf(v)} lacks ${needle}`);
}

async function expectOk(name: string, source: string): Promise<void> {
  const v = await syntaxVerdict(name, source);
  assert.equal(v.state, "OK", `${JSON.stringify(source)}: ${detailOf(v)}`);
}

test("the ESM error shapes node --check passes are DEFEKT", async () => {
  for (const source of ["export const x = ;\n", "export {}; }\n", `import fs ${from("node:fs")};\nexport const x = (;\n`]) {
    await expectDefekt("hook.mts", source, "ERR_INVALID_TYPESCRIPT_SYNTAX");
  }
});

test("TypeScript-only errors are DEFEKT", async () => {
  await expectDefekt("hook.mts", "export const y: = 2;\n", "ERR_INVALID_TYPESCRIPT_SYNTAX");
  await expectDefekt("hook.mts", "export enum E { A }\n", "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
});

test("early errors only V8 finds are DEFEKT, with V8's message", async () => {
  await expectDefekt("hook.mts", "export const a = 1; export { a };\n", "Duplicate export");
  await expectDefekt("hook.mts", "export { nope };\n", "is not defined in module");
  await expectDefekt("hook.mts", "const a = 1; const a = 2; export {};\n", "has already been declared");
});

test("valid sources are OK, including typed code without import or export", async () => {
  await expectOk("hook.mts", "const x: number = 1;\nconsole.log(x);\n");
  await expectOk("hook.mts", `import fs ${from("node:fs")};\nexport const x: number = fs.constants.F_OK;\n`);
  await expectOk("hook.mts", "#!/usr/bin/env node\r\nexport const x: string = \"crlf\";\r\n");
  await expectOk("hook.mts", "﻿export const x = 1;\n");
  await expectOk("hook.mts", "export const x = 1; // trailing comment, no newline");
  await expectOk("hook.mts", "const t = `a${1}b`;\nconst r = /[/]+/g;\nexport default { t, r };\n");
  // Resolution is not this check's business: a missing relative import is OK.
  await expectOk("hook.mts", `import { y } ${from("./does-not-exist.mts")};\nexport const x = y;\n`);
});

test("a checked module is never executed", async () => {
  const marker = "__kherepHookSyntaxProbe";
  const before = process.exitCode;
  const source = `import fs ${from("node:fs")};\n(globalThis as Record<string, unknown>).${marker} = fs;\nprocess.exitCode = 99;\nexport const x = 1;\n`;
  await expectOk("hook.mts", source);
  assert.equal((globalThis as Record<string, unknown>)[marker], undefined);
  assert.equal(process.exitCode, before);
});

test("an unknown resolution failure is UNGEPRUEFT, never OK", async () => {
  // A request that fails with a code outside the known link failures proves
  // neither a parse nor a non-parse.
  const v = await esmParses(`import ${JSON.stringify("node:kherep-no-such-builtin")};\n`);
  assert.equal(v.state, "UNGEPRUEFT", detailOf(v));
});

test("a Node without module.stripTypeScriptTypes gives UNGEPRUEFT, never OK", async () => {
  const holder = module as { stripTypeScriptTypes?: unknown };
  const original = holder.stripTypeScriptTypes;
  holder.stripTypeScriptTypes = undefined;
  try {
    const v = await syntaxVerdict("hook.mts", "export const x = 1;\n");
    assert.equal(v.state, "UNGEPRUEFT", detailOf(v));
  } finally {
    holder.stripTypeScriptTypes = original;
  }
});

test("0 bytes is DEFEKT, other extensions are dispatched or left unchecked", async () => {
  await expectDefekt("hook.mts", "", "0 bytes");
  await expectOk("hook.mjs", "export const x = 1;\n");
  await expectDefekt("hook.mjs", "export const x: number = 1;\n", "rejected by Node's parser");
  assert.equal((await syntaxVerdict("hook.sh", "echo hi\n")).state, "UNGEPRUEFT");
  assert.equal((await syntaxVerdict("hook.ts", "export const x = 1;\n")).state, "UNGEPRUEFT");
});

test("CommonJS keeps the vm.Script path confirmed by node --check", async () => {
  const broken = path.join(TMP, "broken.js");
  fs.writeFileSync(broken, "function guard( { return;\n");
  await expectDefekt(broken, fs.readFileSync(broken, "utf8"), "rejected by node --check");
  const topLevelReturn = path.join(TMP, "return.cjs");
  fs.writeFileSync(topLevelReturn, "if (process.env.NEVER) return;\nmodule.exports = 1;\n");
  await expectOk(topLevelReturn, fs.readFileSync(topLevelReturn, "utf8"));
});

// Node 24.1 also prints its own type-stripping ExperimentalWarning for any .mts
// a child loads (see 7ed7c75), so stderr is never asserted to be empty: only the
// stripper's own warning must be gone, and unrelated ones must still print. The
// child re-emits the text of Node's type-stripping warning itself, so its
// survival is proven on Node versions that no longer print it on their own.
const NODE_STRIP_WARNING = "Type Stripping is an experimental feature and might change at any time";
function warningRun(quiet: boolean): string {
  const lib = pathToFileURL(LIB).href;
  const script = [
    `const m = await import(${JSON.stringify(lib)});`,
    quiet ? "m.quietStripWarning();" : "",
    'await m.syntaxVerdict("hook.mts", "export const x: number = 1;\\n");',
    `process.emitWarning(${JSON.stringify(NODE_STRIP_WARNING)}, "ExperimentalWarning");`,
    'process.emitWarning("kherep unrelated deprecation", "DeprecationWarning");',
  ].join("\n");
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }).stderr;
}

test("only the stripper's ExperimentalWarning is filtered", () => {
  const loud = warningRun(false);
  assert.match(loud, /ExperimentalWarning: stripTypeScriptTypes/, "control: the warning exists unfiltered");
  const quiet = warningRun(true);
  assert.doesNotMatch(quiet, /stripTypeScriptTypes/);
  assert.ok(quiet.includes(`ExperimentalWarning: ${NODE_STRIP_WARNING}`), quiet);
  assert.match(quiet, /DeprecationWarning: kherep unrelated deprecation/);
});

test("the CLI prints the verdict and exits 0, 1 or 2", () => {
  const cases: [string, string, number, string][] = [
    ["ok.mts", "const x: number = 1;\nexport { x };\n", 0, "OK"],
    ["bad.mts", "export const x = ;\n", 1, "DEFEKT"],
    ["script.sh", "echo hi\n", 2, "UNGEPRUEFT"],
  ];
  for (const [name, source, status, word] of cases) {
    const file = path.join(TMP, name); // a native path, so a Windows path on win32
    fs.writeFileSync(file, source);
    const run = spawnSync(process.execPath, [LIB, file], { encoding: "utf8" });
    assert.equal(run.status, status, `${name}: ${run.stdout}${run.stderr}`);
    assert.equal(run.stdout.split(/\s/)[0], word, name);
    assert.doesNotMatch(run.stderr, /stripTypeScriptTypes/, name);
  }
  const missing = spawnSync(process.execPath, [LIB, path.join(TMP, "absent.mts")], { encoding: "utf8" });
  assert.equal(missing.status, 2);
  assert.match(missing.stdout, /^UNGEPRUEFT unreadable/);
});

// Records, never asserts, whether Node still has the gap: it documents the day a
// Node release teaches `node --check` about .mts without turning the suite red.
test("records whether node --check still passes an ESM syntax error in .mts", () => {
  const file = path.join(TMP, "gap.mts");
  fs.writeFileSync(file, "export const x = ;\n");
  const status = spawnSync(process.execPath, ["--check", file]).status;
  console.log(`MEASURED | node ${process.version} --check on "export const x = ;" (.mts) exits ${status}`);
});

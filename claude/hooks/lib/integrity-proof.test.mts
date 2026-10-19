#!/usr/bin/env node
// Unit test for integrity-proof.mts (issue #507, part 2, P2): the final proof
// certifies the bytes it snapshotted, under the grammar Node would load them
// with. A same-inode A->B->A swap while a verdict runs must not be certified,
// because nothing re-reads the file by name; the package scope of a .js file is
// read like a hook file inside the hooks root, and an absent nearer one stays
// absent until the end. Every case lives below <TMP>/node_modules, where Node's
// package-scope search stops, so no package.json above the temporary directory
// decides a grammar; <TMP>/package.json says "module" so that a search ignoring
// that boundary reads it and fails the cases that expect a CommonJS answer.
// Runs on its own as `node integrity-proof.test.mts`, like every suite in CI.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test, type TestContext } from "node:test";

import type { HookFile } from "./hook-inventory.mts";
import * as inventory from "./hook-inventory.mts";
import * as proof from "./integrity-proof.mts";
import * as syntax from "./hook-syntax.mts";
import { normalizePathLike } from "./workspace-scope.mts";
import { hasRule, identity, READ_DENY, windowsAcl } from "../acl-fixture.mts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "integrity-proof-")));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
fs.writeFileSync(path.join(TMP, "package.json"), '{"type":"module"}');
const BROKEN = "const x = ;\n";
const GOOD = "const x = 1;\n";
const NOT_OK = (rel: string): string => `${rel} is not OK in the final check`;
const CHANGED = "a file changed during the final check";
let seq = 0;

type Libs = Parameters<typeof proof.finalProof>[0];
type Real = Record<string, (...args: never[]) => unknown>;
const real = syntax as unknown as Real;
interface Tree { home: string; hooks: string; root: string }

// A Claude home below <TMP>/node_modules with hooks/ and hooks/lib/; `files` are written relative to the home.
function tree(files: Record<string, string> = {}): Tree {
  const home = path.join(TMP, "node_modules", `case-${++seq}`);
  const hooks = path.join(home, "hooks");
  fs.mkdirSync(path.join(hooks, "lib"), { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), text);
  }
  return { home: normalizePathLike(home), hooks, root: fs.realpathSync(hooks) };
}

// The proof over the one wired file rel, with the real parsers unless `wrap` replaces one.
function prove(t: Tree, rel: string, wrap: Partial<Record<"syntaxVerdict" | "esmParses" | "cjsParses", unknown>> = {}) {
  const files: HookFile[] = [{ file: `${t.home}/hooks/${rel}`, rel }];
  const lib = { hookInventory: inventory.hookInventory, wiredFiles: () => ({ files, notes: [], uncoordinated: [], readAny: true }),
    syntaxVerdict: real.syntaxVerdict, esmParses: real.esmParses, cjsParses: real.cjsParses, ...wrap } as unknown as Libs;
  return proof.finalProof(lib, t.home, t.root, files);
}

// Every parser entry wrapped: `during` runs before the real parser, `then` after it, and the
// real verdict comes back unaltered, synchronously where the real parser is synchronous.
function around(during: () => void, then: () => void) {
  const wrap = (name: string) => (...args: never[]) => {
    during();
    let result: unknown;
    try { result = real[name]!(...args); } catch (error) { then(); throw error; }
    if (result instanceof Promise) return result.finally(then);
    then();
    return result;
  };
  return { syntaxVerdict: wrap("syntaxVerdict"), esmParses: wrap("esmParses"), cjsParses: wrap("cjsParses") };
}

test("a same-inode A->B->A swap during the verdict is not certified", async () => {
  const t = tree({ "hooks/guard.js": BROKEN });
  const file = path.join(t.hooks, "guard.js");
  const ino = fs.statSync(file, { bigint: true }).ino;
  const result = await prove(t, "guard.js", around(() => fs.writeFileSync(file, GOOD), () => fs.writeFileSync(file, BROKEN)));
  assert.equal(result.why, NOT_OK("guard.js"));
  assert.equal(fs.readFileSync(file, "utf8"), BROKEN);
  assert.equal(fs.statSync(file, { bigint: true }).ino, ino, "the swap kept the inode");
});

test("a file deleted during the verdict and put back is still judged by its snapshot", async () => {
  const t = tree({ "hooks/guard.js": BROKEN });
  const file = path.join(t.hooks, "guard.js");
  const result = await prove(t, "guard.js", around(() => fs.rmSync(file), () => fs.writeFileSync(file, BROKEN)));
  assert.equal(result.why, NOT_OK("guard.js"));
});

test("the verdict is computed from the source alone; the path is never opened", async () => {
  const lib = { syntaxVerdict: real.syntaxVerdict, esmParses: real.esmParses, cjsParses: real.cjsParses } as unknown as Libs;
  const gone = path.join(TMP, "never", "x");
  assert.equal((await proof.boundVerdict(lib, `${gone}.js`, "return 1;\n", "none")).state, "OK");
  assert.equal((await proof.boundVerdict(lib, `${gone}.js`, BROKEN, "none")).state, "DEFEKT");
  assert.equal((await proof.boundVerdict(lib, `${gone}.js`, "export const x = 1;\n", "none")).state, "OK");
  assert.equal((await proof.boundVerdict(lib, `${gone}.js`, "return 1;\n", "module")).state, "DEFEKT");
  assert.equal((await proof.boundVerdict(lib, `${gone}.cjs`, "export const x = 1;\n", "none")).state, "DEFEKT");
  assert.equal((await proof.boundVerdict(lib, `${gone}.js`, "return 1;\n", "invalid")).state, "UNGEPRUEFT");
});

// [label, files of the home, wired rel, expected OK]; measured against node --check on Node 26.10.
const RET = "return 1;\n";
const EXP = "export const x = 1;\n";
const MATRIX: [string, Record<string, string>, string, boolean][] = [
  ["a top-level return without any package.json", { "hooks/guard.js": RET }, "guard.js", true],
  ["a top-level return under a module scope", { "hooks/lib/package.json": '{"type":"module"}', "hooks/lib/guard.js": RET }, "lib/guard.js", false],
  ["export under an explicit commonjs scope", { "hooks/lib/package.json": '{"type":"commonjs"}', "hooks/lib/guard.js": EXP }, "lib/guard.js", false],
  ["export under a scope without type", { "hooks/lib/package.json": "{}", "hooks/lib/guard.js": EXP }, "lib/guard.js", true],
  ["export under an unknown type string", { "hooks/lib/package.json": '{"type":"other"}', "hooks/lib/guard.js": EXP }, "lib/guard.js", true],
  ["a return under an unknown type string", { "hooks/lib/package.json": '{"type":"other"}', "hooks/lib/guard.js": RET }, "lib/guard.js", true],
  ["a wrapper name redeclared under explicit commonjs", { "hooks/lib/package.json": '{"type":"commonjs"}', "hooks/lib/guard.js": "let require;\n" }, "lib/guard.js", false],
  ["a wrapper name redeclared without a scope (module detection)", { "hooks/guard.js": "let require;\n" }, "guard.js", true],
  ["a nearer scope without type over a typed outer one", { "hooks/package.json": '{"type":"commonjs"}', "hooks/lib/package.json": "{}", "hooks/lib/guard.js": EXP }, "lib/guard.js", true],
  ["a module scope above the hooks root", { "package.json": '{"type":"module"}', "hooks/guard.js": RET }, "guard.js", false],
  ["a scope inside the root behind node_modules", { "hooks/package.json": '{"type":"module"}', "hooks/node_modules/x/guard.js": RET }, "node_modules/x/guard.js", true],
  ["a module scope with a byte order mark", { "hooks/lib/package.json": '\ufeff{"type":"module"}', "hooks/lib/guard.js": EXP }, "lib/guard.js", true],
  ["a return with a shebang", { "hooks/guard.js": "#!/usr/bin/env node\nreturn 1;\n" }, "guard.js", true],
  ["a return with a byte order mark", { "hooks/guard.js": "\ufeffreturn 1;\n" }, "guard.js", true],
  ["export with a shebang under a module scope", { "hooks/package.json": '{"type":"module"}', "hooks/guard.js": "#!/usr/bin/env node\nexport const x = 1;\n" }, "guard.js", true],
  [".cjs with export under a module scope", { "hooks/lib/package.json": '{"type":"module"}', "hooks/lib/guard.cjs": EXP }, "lib/guard.cjs", false],
  [".cjs with a return under an invalid scope", { "hooks/lib/package.json": '{"type":7}', "hooks/lib/guard.cjs": RET }, "lib/guard.cjs", true],
  [".mjs with a return", { "hooks/guard.mjs": RET }, "guard.mjs", false],
];
for (const [label, files, rel, ok] of MATRIX) {
  test(`grammar: ${label}`, async () => {
    const result = await prove(tree(files), rel);
    assert.equal(result.why, ok ? "" : NOT_OK(rel));
  });
}

// Forms Node refuses with ERR_INVALID_PACKAGE_CONFIG (measured on 26.10); a CommonJS-valid source stays unproven.
for (const [label, config] of [["a number type", '{"type":7}'], ["a null type", '{"type":null}'], ["an object type", '{"type":{}}'],
  ["an array", "[]"], ["null", "null"], ["a number", "7"], ["broken JSON", "{"], ["an empty file", ""], ["a number name", '{"name":7}']]) {
  test(`an invalid package scope is not proven: ${label}`, async () => {
    const t = tree({ "hooks/package.json": '{"type":"commonjs"}', "hooks/lib/package.json": config!, "hooks/lib/guard.js": RET });
    assert.equal((await prove(t, "lib/guard.js")).why, NOT_OK("lib/guard.js"));
  });
}

test("a package.json that is a directory is not passed over for the outer scope", async () => {
  const t = tree({ "hooks/package.json": '{"type":"commonjs"}', "hooks/lib/guard.js": RET });
  fs.mkdirSync(path.join(t.hooks, "lib", "package.json"));
  assert.equal((await prove(t, "lib/guard.js")).why, NOT_OK("lib/guard.js"));
});

test("a package.json above the root that cannot be read as a file is not passed over", async () => {
  const t = tree({ "hooks/guard.js": RET });
  fs.mkdirSync(path.join(t.hooks, "..", "package.json"));
  assert.equal((await prove(t, "guard.js")).why, NOT_OK("guard.js"));
});

// A real read error on a present package.json: denied to Everyone (a well-known SID) or
// mode 000. "" when this process can no longer read the file. The one read is the probe:
// only when it succeeds although the deny was read back complete, with the expected
// rights and acting on the file itself, and the file, its bytes and that ACL are
// unchanged after it, the measured fact comes back as a skip reason. Anything else fails.
function unreadable(t: TestContext, file: string): string {
  const id = identity(file);
  const bytes = fs.readFileSync(file);
  let acl = "";
  if (process.platform !== "win32") {
    if (process.getuid?.() === 0) return "root reads every file";
    fs.chmodSync(file, 0o000);
    t.after(() => fs.chmodSync(file, 0o600));
  } else {
    const icacls = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "icacls.exe");
    t.after(() => assert.equal(spawnSync(icacls, [file, "/reset"]).status, 0, "the read deny could be lifted"));
    assert.equal(spawnSync(icacls, [file, "/deny", "*S-1-1-0:(R)"]).status, 0, "icacls denied the read");
    const denied = windowsAcl(file, "S-1-1-0");
    assert.ok(hasRule(denied, "Deny", READ_DENY), "the read deny entry is in place");
    acl = denied!.text;
  }
  assert.equal(identity(file), id, "the file is the one written");
  let read: Buffer;
  try {
    read = fs.readFileSync(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    assert.ok(code === "EPERM" || code === "EACCES", `the read is refused by the OS, got ${code}`);
    return "";
  }
  assert.ok(read.equals(bytes) && identity(file) === id, "the read returned the file's own bytes");
  if (process.platform === "win32") assert.ok(windowsAcl(file, "S-1-1-0")?.text === acl, "the deny entry is unchanged after the read");
  return process.platform === "win32" ? "this process reads a file its DACL denies" : "this process reads a file of mode 000";
}

test("a package.json that cannot be read is not passed over for the outer scope", async (t) => {
  const tr = tree({ "hooks/package.json": '{"type":"commonjs"}', "hooks/lib/package.json": "{}", "hooks/lib/guard.js": RET });
  const pkg = path.join(tr.hooks, "lib", "package.json");
  const bypass = unreadable(t, pkg);
  if (bypass) return t.skip(bypass);
  assert.equal((await prove(tr, "lib/guard.js")).why, NOT_OK("lib/guard.js"));
});

test("a package.json inside the root changed in place during the verdict is caught", async () => {
  const t = tree({ "hooks/lib/package.json": '{"type":"commonjs"}', "hooks/lib/guard.js": RET });
  const pkg = path.join(t.hooks, "lib", "package.json");
  const result = await prove(t, "lib/guard.js", around(() => fs.writeFileSync(pkg, '{"type":"module"}'), () => {}));
  assert.equal(result.why, CHANGED);
});

test("a nearer package.json created during the verdict is caught", async () => {
  const t = tree({ "hooks/package.json": '{"type":"commonjs"}', "hooks/lib/guard.js": RET });
  const nearer = path.join(t.hooks, "lib", "package.json");
  const result = await prove(t, "lib/guard.js", around(() => fs.writeFileSync(nearer, '{"type":"module"}'), () => {}));
  assert.equal(result.why, CHANGED);
  assert.equal(fs.readFileSync(nearer, "utf8"), '{"type":"module"}', "the nearer scope stayed");
});

// Review of 4a0aaa9: Node checks every top-level "type" and "name", duplicates included,
// by its raw key, and an unrecognized type string leaves the scope as it was (measured
// against node --check on 26.10). JSON.parse keeps only the last value of a key.
const B = String.fromCharCode(92); // a backslash, for the escaped-key rows
const DUPLICATES: [string, string, string, boolean][] = [
  ["an invalid type before a valid one", '{"type":7,"type":"module"}', EXP, false],
  ["an invalid name before a valid one", '{"name":7,"name":"a"}', RET, false],
  ["two valid types, the last decides", '{"type":"commonjs","type":"module"}', EXP, true],
  ["two valid types, the last decides (return)", '{"type":"commonjs","type":"module"}', RET, false],
  ["an unknown type after module keeps module", '{"type":"module","type":"other"}', RET, false],
  ["two valid names", '{"name":"a","name":"b"}', RET, true],
  ["an escaped type key is another key", `{"typ${B}u0065":7}`, RET, true],
  ["an escaped type key does not override commonjs", `{"type":"commonjs","typ${B}u0065":"module"}`, EXP, false],
  ["an escaped type value is that value", `{"type":"modul${B}u0065"}`, RET, false],
  ["a nested type is not the package type", '{"x":{"type":7},"y":[{"type":7}],"z":"}\\",\\"type\\":7","type":"module"}', EXP, true],
];
for (const [label, config, source, ok] of DUPLICATES) {
  test(`package scope fields: ${label}`, async () => {
    const t = tree({ "hooks/lib/package.json": config, "hooks/lib/guard.js": source });
    assert.equal((await prove(t, "lib/guard.js")).why, ok ? "" : NOT_OK("lib/guard.js"));
  });
}

// Node reads a package.json at the file system root too. The walk takes its parent
// through a seam here, so `top` stands in for the root and nothing at the real root is read.
test("the package scope search reads the file system root's package.json", () => {
  const t = tree({ "package.json": '{"type":"commonjs"}', "hooks/guard.js": EXP });
  const top = path.dirname(t.hooks);
  const parentOf = (dir: string): string => (dir === top ? dir : path.dirname(dir));
  assert.equal(proof.scopeOf(path.join(t.hooks, "guard.js"), t.root, () => null, new Set(), parentOf), "commonjs");
  fs.rmSync(path.join(top, "package.json"));
  assert.equal(proof.scopeOf(path.join(t.hooks, "guard.js"), t.root, () => null, new Set(), parentOf), "none");
});

#!/usr/bin/env node
// Unit test for the node --check confirmation of .js and .cjs in hook-syntax.mts
// (issues #284, #292 and #298). Synthetic stderr into checkFailureVerdict, real
// children through syntaxVerdict, all files in one mkdtemp directory whose path
// has a space. Runs on its own as `node hook-syntax-check.test.mts`, like every
// suite in CI. Node 22.18 and 24.1 print their own ExperimentalWarning for a
// .mts child, so no stderr here is asserted to be empty.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { checkFailureVerdict, syntaxVerdict, type SyntaxVerdict } from "./hook-syntax.mts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hook syntax-"));
after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

const detailOf = (v: SyntaxVerdict): string => (v.state === "OK" ? "" : v.detail);
const write = (name: string, source: string): string => {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, source);
  return file;
};

test("CommonJS keeps the vm.Script path confirmed by node --check", async () => {
  const broken = write("broken.js", "function guard( { return;\n");
  const v = await syntaxVerdict(broken, fs.readFileSync(broken, "utf8"));
  assert.equal(v.state, "DEFEKT", detailOf(v));
  assert.match(detailOf(v), /rejected by node --check/);
  const topLevelReturn = write("return.cjs", "if (process.env.NEVER) return;\nmodule.exports = 1;\n");
  assert.equal((await syntaxVerdict(topLevelReturn, fs.readFileSync(topLevelReturn, "utf8"))).state, "OK");
});

// A node --check that did not run or did not finish proves nothing (#284).
test("a node --check that did not run or finish is UNGEPRUEFT, not DEFEKT", async () => {
  const broken = write("unconfirmed.js", "function guard( { return;\n");
  const execPath = process.execPath;
  process.execPath = path.join(TMP, "no-such-node"); // a real ENOENT through the public path
  try {
    const v = await syntaxVerdict(broken, fs.readFileSync(broken, "utf8"));
    assert.equal(v.state, "UNGEPRUEFT", detailOf(v));
    assert.match(detailOf(v), /ENOENT/);
  } finally {
    process.execPath = execPath;
  }
  const caught = (fn: () => void): unknown => { try { fn(); } catch (e) { return e; } return undefined; };
  const io = { stdio: ["ignore", "ignore", "pipe"] as ["ignore", "ignore", "pipe"] };
  const timedOut = caught(() => execFileSync(process.execPath, ["--check", broken], { ...io, timeout: 1 })); // a real ETIMEDOUT
  assert.equal(checkFailureVerdict(timedOut, broken).state, "UNGEPRUEFT", String((timedOut as Error).message));
  const shapes = [
    { status: null, signal: "SIGKILL", stderr: Buffer.alloc(0) },
    { status: 9, signal: null, stderr: "node: --bogus is not allowed in NODE_OPTIONS\n" },
    { status: 1, signal: null, stderr: "Error: Cannot find module 'x'\n" },
  ];
  // A preload's SyntaxError block is no longer told apart by its name (#298):
  // the child runs without NODE_OPTIONS, guarded by the forging-preload test below.
  for (const s of shapes) assert.equal(checkFailureVerdict(Object.assign(new Error("Command failed"), s), broken).state, "UNGEPRUEFT", JSON.stringify(s));
  const rejected = caught(() => execFileSync(process.execPath, ["--check", broken], { ...io, timeout: 15_000 }));
  assert.equal(checkFailureVerdict(rejected, broken).state, "DEFEKT", String((rejected as Error).message));
});

// ---- issue #292: the rejection block, wherever it sits in stderr ----

// The block node --check prints, measured on Node 26.10.0: location line,
// source line, caret line, blank line, SyntaxError line, then the stack.
const block = (location: string, eol = "\n"): string =>
  [`${location}:1`, "const x = ;", "          ^", "", "SyntaxError: Unexpected token ';'", "    at wrapSafe (node:internal/modules/cjs/loader:1888:18)", "", "Node.js v26.10.0", ""].join(eol);
const failure = (stderr: string, status: number | null = 1, signal: string | null = null): Error =>
  Object.assign(new Error("Command failed"), { status, signal, stderr: Buffer.from(stderr) });

test("a rejection block after other stderr lines is DEFEKT with the real message", () => {
  const file = path.join(TMP, "broken.js");
  const spaced = path.join(TMP, "my hook.js");
  const winFile = "C:\\Users\\Example User\\hooks\\broken.js";
  const cases: [string, string, string][] = [
    ["one preload line", file, `preload says hi\n${block(file)}`],
    ["three preload lines", file, `one\ntwo\nthree\n${block(file)}`],
    ["a forged SyntaxError line first", file, `SyntaxError: fake from preload\n${block(file)}`],
    ["Node's warning preamble", file, `(node:1) Warning: Failed to load the ES module: ${file}. Make sure to set "type": "module" in the nearest package.json file or use the .mjs extension.\n(Use \`node --trace-warnings ...\` to show where the warning was created)\n${block(file)}`],
    ["a NODE_DEBUG line", file, `MODULE 1: looking for "${file}" in []\n${block(file)}`],
    ["a path with spaces", spaced, `preload says hi\n${block(spaced)}`],
    ["a Windows path with CRLF", file, `preload says hi\r\n${block(winFile, "\r\n")}`],
  ];
  for (const [label, checked, stderr] of cases) {
    const v = checkFailureVerdict(failure(stderr), checked);
    assert.equal(v.state, "DEFEKT", `${label}: ${detailOf(v)}`);
    assert.equal(detailOf(v), "rejected by node --check: SyntaxError: Unexpected token ';'", label);
  }
  // The source line of the block may itself start with SyntaxError; the
  // message reported is still Node's, the line after the blank one.
  const own = checkFailureVerdict(failure(`${file}:1\nSyntaxError = ;\n            ^\n\nSyntaxError: Invalid left-hand side in assignment\n`), file);
  assert.equal(detailOf(own), "rejected by node --check: SyntaxError: Invalid left-hand side in assignment");
  // Any well-formed block counts (#298); the name only shapes the detail, and
  // Windows paths compare case-insensitively there, POSIX paths do not.
  const upper = checkFailureVerdict(failure(`hi\r\n${block(winFile.toUpperCase(), "\r\n")}`), file);
  assert.equal(upper.state, "DEFEKT", detailOf(upper));
  assert.equal(detailOf(upper).endsWith(`(Node named it ${winFile.toUpperCase()})`), process.platform !== "win32", detailOf(upper));
});

test("no well-formed rejection block, or no own non-zero exit, is UNGEPRUEFT", () => {
  const file = path.join(TMP, "broken.js");
  const far = `${file}:1\none\ntwo\nthree\nfour\nSyntaxError: Unexpected token ';'\n`;
  const shapes: [string, Error][] = [
    ["location line five lines above", failure(far)],
    ["a SyntaxError line without a location line", failure("preload says hi\nSyntaxError: fake from preload\n")],
    ["a node: location with a plain Error", failure("node:internal/modules/helpers:91\n    throw error;\n    ^\n\nError: Invalid package config /x/package.json.\n")],
    ["a node: location with a SyntaxError", failure("node:internal/x:1\nsrc\n^\n\nSyntaxError [ERR_X]: from Node itself\n")],
    ["exit 0", failure(block(file), 0)],
    ["a signal", failure(block(file), null, "SIGTERM")],
  ];
  for (const [label, error] of shapes) assert.equal(checkFailureVerdict(error, file).state, "UNGEPRUEFT", label);
});

// A real child: NODE_OPTIONS names a preload for the duration. The check child
// must not run it, so neither its output nor its exit code reaches the verdict.
let preloads = 0;
async function underPreload(preloadSource: string, file: string): Promise<SyntaxVerdict> {
  const preload = write(`pre ${++preloads}.cjs`, preloadSource);
  const before = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`; // quoted and escaped for a path with spaces or backslashes
  try {
    return await syntaxVerdict(file, fs.readFileSync(file, "utf8"));
  } finally {
    if (before === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = before;
  }
}

test("a NODE_OPTIONS preload neither hides nor fakes a node --check rejection", async () => {
  const broken = write("my broken.js", "const x = ;\n");
  const healthy = write("my return.cjs", "if (process.env.NEVER) return;\nmodule.exports = 1;\n");
  const print = 'process.stderr.write("preload says hi\\n");';
  // Control: the quoted NODE_OPTIONS form really loads the preload in a plain
  // child, so the cases below are not green just because nothing was loaded.
  const marker = path.join(TMP, "preload ran.txt");
  const probe = write(`pre ${++preloads}.cjs`, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "1");`);
  execFileSync(process.execPath, ["-e", "0"], { stdio: "ignore", env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(probe)}` } });
  assert.ok(fs.existsSync(marker), "the NODE_OPTIONS preload did not load in a plain child");
  let v = await underPreload(print, broken);
  assert.equal(v.state, "DEFEKT", `print-only preload: ${detailOf(v)}`);
  v = await underPreload(`${print}\nprocess.exit(0);`, broken);
  assert.equal(v.state, "DEFEKT", `exit(0) preload: ${detailOf(v)}`);
  const forge = `process.stderr.write(${JSON.stringify(block(healthy))});\nprocess.exit(1);`;
  v = await underPreload(forge, healthy);
  assert.equal(v.state, "OK", `forging preload: ${detailOf(v)}`);
});

// ---- issue #298: Node names the rejected file by another name ----

const expectDefekt = async (file: string, named: RegExp | null): Promise<void> => {
  const v = await syntaxVerdict(file, fs.readFileSync(file, "utf8"));
  assert.equal(v.state, "DEFEKT", `${file}: ${detailOf(v)}`);
  if (named) assert.match(detailOf(v), named);
};

test("a block whose location names another file is DEFEKT, and the detail says so", () => {
  const file = path.join(TMP, "broken.js");
  const other = path.join(TMP, "other-broken.js");
  for (const where of [other, "other.js", "/etc/elsewhere/abs.js", "https://example.org/p/remote.js", "file:///tmp/x.js", "weird:name:9", "legacy.js"]) {
    const v = checkFailureVerdict(failure(`hi\n${block(where)}`), file);
    assert.equal(v.state, "DEFEKT", `${where}: ${detailOf(v)}`);
    assert.equal(detailOf(v), `rejected by node --check: SyntaxError: Unexpected token ';' (Node named it ${where})`);
  }
  // "Unexpected end of input": empty source and caret lines put the location four lines up.
  const eoi = checkFailureVerdict(failure(`${file}:2\n\n\n\nSyntaxError: Unexpected end of input\n`), file);
  assert.equal(detailOf(eoi), "rejected by node --check: SyntaxError: Unexpected end of input");
});

test("real children: a directory link and a sourceURL comment are DEFEKT", async () => {
  const realDir = path.join(TMP, "real dir");
  fs.mkdirSync(realDir, { recursive: true });
  fs.writeFileSync(path.join(realDir, "target-real.js"), "const x = ;\n");
  const dirLink = path.join(TMP, "dirlink");
  fs.symlinkSync(realDir, dirLink, process.platform === "win32" ? "junction" : "dir"); // junctions need no privilege
  await expectDefekt(path.join(dirLink, "target-real.js"), null);
  await expectDefekt(write("sourceurl.js", "//# sourceURL=other.js\nconst x = ;\n"), /\(Node named it other\.js\)$/);
});

test("a real child on a file link with another name in another directory is DEFEKT", async (t) => {
  const target = path.join(TMP, "real dir", "link-target.js");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "const x = ;\n");
  const link = path.join(TMP, "link dir", "hook-link.js");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  try {
    fs.symlinkSync(target, link, "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("file symlink creation needs a Windows privilege; the directory link case remains mandatory");
      return;
    }
    throw error;
  }
  await expectDefekt(link, /link-target\.js\)$/);
});

test("a malformed package.json next to the file is Node's own failure: UNGEPRUEFT", async () => {
  const dir = path.join(TMP, "bad package");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), "{");
  const file = path.join(dir, "return.js"); // vm.Script rejects it, so node --check is asked
  fs.writeFileSync(file, "if (process.env.NEVER) return;\nmodule.exports = 1;\n");
  const v = await syntaxVerdict(file, fs.readFileSync(file, "utf8"));
  assert.equal(v.state, "UNGEPRUEFT", detailOf(v));
});

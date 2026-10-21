// Issue #592. The pointer check drift-check.sh runs on the Claude home: the
// pointer names a source that runs all three stable hook names, and the commit it
// records is the commit of the source drift-check runs from. Exit codes: 0 ok,
// 3 drift, anything else HOOK-CHECK-FAIL in drift-check.sh. Throwaway homes and
// sources only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { checkPointer } from "./control-plane-pointer.mts";

const SCRIPT = path.join(import.meta.dirname, "control-plane-pointer.mts");
const REL = "kherep/control-plane/source.json";
const hasGit = () => spawnSync("git", ["--version"], { windowsHide: true }).status === 0;

function git(cwd: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env, windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

// A checkout with the three hooks at one commit, and a Claude home whose pointer names it.
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-pointer-check-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "checkout");
  const hooks = path.join(source, "modules", "control-plane", "node");
  fs.mkdirSync(hooks, { recursive: true });
  for (const name of ["deliver", "wake", "attribution"]) fs.writeFileSync(path.join(hooks, `${name}-hook.mts`), "");
  git(source, "init", "-q");
  git(source, "add", ".");
  git(source, "-c", "user.name=Kherep Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", "fixture");
  const head = git(source, "rev-parse", "HEAD");
  const home = path.join(root, "claude");
  const file = path.join(home, ...REL.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const pointer = (value: unknown) => fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  const at = (commit: string) => ({ version: 1, root: source, commit, kind: "checkout", verified: true });
  return { root, source, hooks, head, home, file, pointer, at };
}

test("a pointer to the commit drift-check runs from is in sync; another commit is POINTER-STALE", (t) => {
  if (!hasGit()) return t.skip("git is not available");
  const f = fixture(t);
  f.pointer(f.at(f.head));
  assert.deepEqual(checkPointer(f.home, f.source), { line: `ok            ${REL} (checkout ${f.head.slice(0, 7)})`, drift: false });

  f.pointer(f.at("f".repeat(40)));
  assert.deepEqual(checkPointer(f.home, f.source), { line: `POINTER-STALE ${REL} (commit fffffff != ${f.head.slice(0, 7)})`, drift: true });
});

test("a pointer that is not the pointer record is POINTER-INVALID; no pointer is MISSING-LIVE", (t) => {
  if (!hasGit()) return t.skip("git is not available");
  const f = fixture(t);
  for (const value of ["{", "null", { version: 1, root: "relative", kind: "checkout", verified: true },
    { version: 1, root: f.source, commit: "not-a-commit", kind: "checkout", verified: true }]) {
    f.pointer(value);
    assert.deepEqual(checkPointer(f.home, f.source), { line: `POINTER-INVALID ${REL}`, drift: true }, JSON.stringify(value));
  }
  fs.rmSync(f.file);
  assert.deepEqual(checkPointer(f.home, f.source), { line: `MISSING-LIVE  ${REL}`, drift: true });
});

test("every stable hook name must resolve; the first that does not is reported by name", (t) => {
  if (!hasGit()) return t.skip("git is not available");
  const f = fixture(t);
  f.pointer(f.at("f".repeat(40)));
  for (const name of ["deliver", "wake", "attribution"]) {
    const hook = path.join(f.hooks, `${name}-hook.mts`);
    fs.renameSync(hook, `${hook}.away`);
    assert.deepEqual(checkPointer(f.home, f.source),
      { line: `POINTER-UNRESOLVED ${REL} (missing-hook: the pointer's source cannot run the ${name} hook)`, drift: true }, name);
    fs.renameSync(`${hook}.away`, hook);
  }
  // Two missing: the first in the order deliver, wake, attribution.
  for (const name of ["wake", "attribution"]) fs.rmSync(path.join(f.hooks, `${name}-hook.mts`));
  assert.match(checkPointer(f.home, f.source).line, /cannot run the wake hook\)$/);
});

// drift-check.sh reports HOOK-CHECK-FAIL for any exit but 0 and 3. checkPointer
// itself never throws (every read in it fails soft into a verdict), so that line
// comes only from a check that cannot run: wrong arguments, or a source whose
// modules do not load. Both exit 1, never 0 or 3.
test("the check exits 0 in sync, 3 on drift and 1 when it cannot run", (t) => {
  if (!hasGit()) return t.skip("git is not available");
  const f = fixture(t);
  const run = (script: string, ...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  f.pointer(f.at(f.head));
  assert.equal(run(SCRIPT, "check", f.home, f.source).status, 0);
  f.pointer(f.at("f".repeat(40)));
  const stale = run(SCRIPT, "check", f.home, f.source);
  assert.deepEqual([stale.status, stale.stdout.trim()], [3, `POINTER-STALE ${REL} (commit fffffff != ${f.head.slice(0, 7)})`]);

  const usage = run(SCRIPT, "check", f.home);
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /^FATAL: control-plane pointer: usage: /m);
  // The script alone, without the modules it imports.
  const lone = path.join(f.root, "lone", "bootstrap", "control-plane-pointer.mts");
  fs.mkdirSync(path.dirname(lone), { recursive: true });
  fs.copyFileSync(SCRIPT, lone);
  const unloadable = run(lone, "check", f.home, f.source);
  assert.equal(unloadable.status, 1, unloadable.stderr);
  assert.equal(unloadable.stdout, "");
});

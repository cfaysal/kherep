// Issue #23. Section D of install.sh binds the commit-msg hook through
// core.hooksPath. The system scope binds EVERY account on the host, and Git for
// Windows can ship a system file that a non-elevated shell may write. A writable
// file is therefore no consent: the installer writes the system scope only with
// KHEREP_INSTALL_SYSTEM_HOOKSPATH=1. Without it the installer reads the value and
// reports a difference instead of replacing it.
//
// Section D runs here as install.sh has it, with GIT_CONFIG_SYSTEM and
// GIT_CONFIG_GLOBAL on throwaway files, so no case can reach the host's real
// git configuration. The global and repo-local bindings keep their behaviour.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

const HERE = import.meta.dirname;
const SWITCH = "KHEREP_INSTALL_SYSTEM_HOOKSPATH";
const OTHER = "/fixture/older/githooks";
// Git Bash wants /c/... on Windows; install.sh refuses a drive-letter path.
const slash = (value: string): string =>
  value.replace(/\\/g, "/").replace(/^([A-Za-z]):\//, (_match, drive: string) => `/${drive.toLowerCase()}/`);

interface Fixture { root: string; claude: string; hooks: string; ws: string; system: string; global: string }

function fixture(t: TestContext): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-issue23-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const claude = path.join(root, "home", ".claude");
  const f = { root, claude, hooks: path.join(claude, "kherep", "githooks"), ws: path.join(root, "workspace"),
    system: path.join(root, "gitconfig-system"), global: path.join(root, "gitconfig-global") };
  fs.mkdirSync(f.hooks, { recursive: true });
  fs.mkdirSync(f.ws);
  fs.writeFileSync(path.join(f.hooks, "commit-msg"), "#!/bin/sh\nexit 0\n");
  return f;
}

const seed = (file: string, value: string): void => fs.writeFileSync(file, `[core]\n\thooksPath = ${value}\n`);

function readHooksPath(file: string): string {
  const run = spawnSync("git", ["config", "--file", file, "--get", "core.hooksPath"], { encoding: "utf8" });
  return run.status === 0 ? run.stdout.trim() : `<exit ${run.status}>`;
}

// Git for Windows stores the drive form C:/... of the /c/... path install.sh
// passes (OP-755); compare in the Git Bash form.
const sameDir = (stored: string, dir: string): boolean => slash(stored) === slash(dir);

// Section D to the end of install.sh, so the verdict of the post-commit phase
// (exit 0, or 1 after a collected failure) is part of the run.
function install(f: Fixture, extraEnv: Record<string, string> = {}): { status: number | null; out: string } {
  const source = fs.readFileSync(path.join(HERE, "install.sh"), "utf8");
  const from = source.indexOf("# ---- D.");
  assert.notEqual(from, -1, "install.sh lost its D section marker");
  const script = [
    "set -Eeuo pipefail",
    `. '${slash(path.join(HERE, "profile.sh"))}' || exit $?`,
    `REPO_ROOT='${slash(path.join(HERE, ".."))}'`,
    `CLAUDE_HOME='${slash(f.claude)}'`,
    `WS='${slash(f.ws)}'`,
    "post_rc=0",
    source.slice(from),
  ].join("\n");
  // Built from scratch; only PATH is inherited, so no GIT_CONFIG_* or KHEREP_*
  // from the caller can redirect a write to the host or flip a switch.
  const run = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: slash(path.join(f.root, "home")),
      GIT_CONFIG_SYSTEM: f.system, GIT_CONFIG_GLOBAL: f.global, ...extraEnv },
  });
  return { status: run.status, out: `${run.stdout}\n${run.stderr}` };
}

const systemLines = (out: string): string[] => out.split(/\r?\n/).filter((line) => /\bsystem\b/.test(line));

test("without the opt-in a writable system value stays and the difference is reported once", (t) => {
  const f = fixture(t);
  seed(f.system, OTHER);
  const before = fs.readFileSync(f.system);
  const run = install(f);
  assert.equal(run.status, 0, run.out);
  assert.deepEqual(fs.readFileSync(f.system), before, "the system file was rewritten without the opt-in");
  const lines = systemLines(run.out);
  assert.equal(lines.length, 1, run.out);
  assert.ok(lines[0].includes(`'${OTHER}'`), lines[0]);
  assert.ok(lines[0].includes(slash(f.hooks)), lines[0]);
  assert.ok(lines[0].includes(`${SWITCH}=1`), lines[0]);
  // The global binding is unchanged: it is still written.
  assert.ok(sameDir(readHooksPath(f.global), f.hooks), run.out);
});

test("without the opt-in an unset system value is reported and no system file is created", (t) => {
  const f = fixture(t);
  const run = install(f);
  assert.equal(run.status, 0, run.out);
  assert.equal(fs.existsSync(f.system), false, "a system file was created without the opt-in");
  const lines = systemLines(run.out);
  assert.equal(lines.length, 1, run.out);
  assert.match(lines[0], /\bunset\b/);
  assert.ok(lines[0].includes(`${SWITCH}=1`), lines[0]);
});

test("with the opt-in the system value is written and the replaced value is reported", (t) => {
  const f = fixture(t);
  seed(f.system, OTHER);
  const run = install(f, { [SWITCH]: "1" });
  assert.equal(run.status, 0, run.out);
  assert.ok(sameDir(readHooksPath(f.system), f.hooks), `system value: ${readHooksPath(f.system)}`);
  const lines = systemLines(run.out);
  assert.equal(lines.length, 1, run.out);
  assert.ok(lines[0].includes(`'${OTHER}'`), lines[0]);
});

test("an equal system value is neither reported nor rewritten, with or without the opt-in", (t) => {
  const f = fixture(t);
  // The form Git for Windows stores; on macOS and Linux the path itself.
  seed(f.system, f.hooks.replace(/\\/g, "/"));
  const before = fs.readFileSync(f.system);
  const past = new Date("2001-01-01T00:00:00Z");
  for (const extra of [{}, { [SWITCH]: "1" }] as Record<string, string>[]) {
    fs.utimesSync(f.system, past, past);
    const run = install(f, extra);
    assert.equal(run.status, 0, run.out);
    assert.deepEqual(systemLines(run.out), [], run.out);
    assert.deepEqual(fs.readFileSync(f.system), before);
    assert.equal(fs.statSync(f.system).mtimeMs, past.getTime(), `system file rewritten with ${JSON.stringify(extra)}`);
  }
});

// Only the exact value 1 opts in, like the skip switches beside it: a typo or an
// empty value falls on the side of leaving every other account alone.
test("any value other than 1 leaves the system value alone", (t) => {
  const f = fixture(t);
  seed(f.system, OTHER);
  const before = fs.readFileSync(f.system);
  for (const value of ["0", "", "yes", "true", " 1"]) {
    const run = install(f, { [SWITCH]: value });
    assert.equal(run.status, 0, run.out);
    assert.deepEqual(fs.readFileSync(f.system), before, `${SWITCH}=${JSON.stringify(value)} wrote the system file`);
  }
});

test("KHEREP_INSTALL_SKIP_GITCONFIG=1 leaves both scopes alone, even with the opt-in", (t) => {
  const f = fixture(t);
  seed(f.system, OTHER);
  seed(f.global, OTHER);
  const system = fs.readFileSync(f.system);
  const global = fs.readFileSync(f.global);
  const run = install(f, { KHEREP_INSTALL_SKIP_GITCONFIG: "1", [SWITCH]: "1" });
  assert.equal(run.status, 0, run.out);
  assert.match(run.out, /SKIP_GITCONFIG=1/);
  assert.deepEqual(fs.readFileSync(f.system), system);
  assert.deepEqual(fs.readFileSync(f.global), global);
});

// An operator who asked for the system binding and did not get it must see an
// error, not a line that reads like a normal run.
test("an opt-in the system file refuses fails the install visibly", (t) => {
  const f = fixture(t);
  f.system = path.join(f.root, "no-such-dir", "gitconfig-system");
  const run = install(f, { [SWITCH]: "1" });
  assert.equal(run.status, 1, run.out);
  assert.match(run.out, /WARNING .*system core\.hooksPath/);
  assert.match(run.out, /DONE WITH ERRORS/);
});

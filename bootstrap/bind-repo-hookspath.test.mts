// bind-repo-hookspath.sh points every repository under the workspace at the
// shared hook directory. Repositories parked under _deprecated are skipped,
// as the smoke test's coverage scan skips them (issue #99). Git runs with
// GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM on throwaway files.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

const SCRIPT = path.join(import.meta.dirname, "bind-repo-hookspath.sh");
// Git Bash wants /c/... on Windows.
const slash = (value: string): string =>
  value.replace(/\\/g, "/").replace(/^([A-Za-z]):\//, (_match, drive: string) => `/${drive.toLowerCase()}/`);

interface Setup { ws: string; hooks: string; env: NodeJS.ProcessEnv }

function setup(t: TestContext): Setup {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-bind-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hooks = path.join(root, "githooks");
  fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, "commit-msg"), "#!/bin/sh\nexit 0\n");
  // Built from scratch; only PATH is inherited.
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: path.join(root, "global"),
    GIT_CONFIG_SYSTEM: path.join(root, "system") };
  return { ws: path.join(root, "ws"), hooks, env };
}

function initRepo(dir: string, env: NodeJS.ProcessEnv): void {
  fs.mkdirSync(dir, { recursive: true });
  const run = spawnSync("git", ["init", "-q", dir], { encoding: "utf8", env });
  assert.equal(run.status, 0, run.stderr);
}

function localHooksPath(repo: string, env: NodeJS.ProcessEnv): string {
  const run = spawnSync("git", ["-C", repo, "config", "--local", "--get", "core.hooksPath"], { encoding: "utf8", env });
  return run.status === 0 ? run.stdout.trim() : "";
}

test("the path normalisation self-test passes", () => {
  const run = spawnSync("bash", [slash(SCRIPT), "--selftest"], { encoding: "utf8" });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});

test("repositories under _deprecated are not bound", (t) => {
  const f = setup(t);
  const live = path.join(f.ws, "app");
  const parked = path.join(f.ws, "_deprecated", "old-app");
  const nested = path.join(f.ws, "group", "_deprecated", "older");
  for (const repo of [live, parked, nested]) initRepo(repo, f.env);
  const run = spawnSync("bash", [slash(SCRIPT), slash(f.ws), slash(f.hooks)], { encoding: "utf8", env: f.env });
  const out = `${run.stdout}\n${run.stderr}`;
  assert.equal(run.status, 0, out);
  assert.match(out, /1 bound, 0 skipped, 0 failed/);
  assert.equal(slash(localHooksPath(live, f.env)), slash(f.hooks), out);
  assert.equal(localHooksPath(parked, f.env), "", out);
  assert.equal(localHooksPath(nested, f.env), "", out);
});

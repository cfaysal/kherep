// Issue #75. On Windows the Claude settings carry the workspace in native form
// (D:/Work), because Node tools resolve a Git Bash form /d/... to D:\d\...
// Bash consumers convert it back before they validate it.
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { renderSettings } from "./render-profile.mts";
import { workspaceEnvPath } from "./render-profile-paths.mts";

const bashAvailable = spawnSync("bash", ["-c", "exit 0"]).status === 0;

test("the workspace env value is native on a Windows host and bash-visible elsewhere", () => {
  for (const input of ["/d/Work", "D:/Work", "D:\\Work", "d:/Work"]) {
    assert.equal(workspaceEnvPath("win", input, "win32"), "D:/Work", input);
  }
  assert.equal(workspaceEnvPath("win", "/ws", "win32"), "/ws");
  assert.equal(workspaceEnvPath("win", "/d/Work", "linux"), "/d/Work");
  assert.equal(workspaceEnvPath("win", "D:/Work", "linux"), "/d/Work");
  assert.equal(workspaceEnvPath("mac", "/Users/example/Work", "darwin"), "/Users/example/Work");
  assert.equal(workspaceEnvPath("mac", "D:/Work", "win32"), "/d/Work");
});

function render(t: TestContext, profile: string, platform: string, existingEnv: Record<string, string>): Record<string, string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-workspace-env-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = (name: string) => path.join(dir, name);
  fs.writeFileSync(file("user.src.json"), JSON.stringify({ env: { KHEREP_WORKSPACE: "" } }));
  fs.writeFileSync(file("project.src.json"), "{}");
  fs.writeFileSync(file("user.live.json"), JSON.stringify({ env: existingEnv }));
  renderSettings([
    profile, "/d/Work", "E:/Keys", "/c/Users/example/.claude",
    file("user.src.json"), file("project.src.json"), file("user.live.json"), "-",
    file("user.out.json"), file("project.out.json"),
  ], platform);
  return (JSON.parse(fs.readFileSync(file("user.out.json"), "utf8")) as { env: Record<string, string> }).env;
}

test("a Windows re-install rewrites an old Git Bash workspace value", (t) => {
  const env = render(t, "win", "win32", { KHEREP_WORKSPACE: "/d/Work", HOST_ONLY: "kept" });
  assert.equal(env.KHEREP_WORKSPACE, "D:/Work");
  assert.equal(env.KHEREP_CREDENTIALS_ROOT, "/e/Keys", "the second root keeps its bash form");
  assert.equal(env.HOST_ONLY, "kept");
});

test("macOS and Linux renders keep the bash-visible workspace", (t) => {
  assert.equal(render(t, "win", "linux", {}).KHEREP_WORKSPACE, "/d/Work");
  assert.equal(render(t, "mac", "darwin", {}).KHEREP_WORKSPACE, "/d/Work");
});

function shell(script: string, env: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  const profile = path.join(import.meta.dirname, "profile.sh").replace(/\\/g, "/");
  return spawnSync("bash", ["-c", `. '${profile}' || exit $?; ${script}`], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: "/tmp/kherep-home", ...env },
  });
}

test("bash consumers accept the native workspace on the win profile", { skip: !bashAvailable }, () => {
  const script = `WS="$(kherep_shell_path "$(kherep_env WORKSPACE)")"; kherep_validate_shell_path KHEREP_WORKSPACE "$WS" && printf '%s' "$WS"`;
  for (const value of ["D:/Work", "D:\\Work", "/d/Work"]) {
    const result = shell(script, { KHEREP_PROFILE: "win", KHEREP_WORKSPACE: value });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "/d/Work", value);
  }
});

test("the mac profile still refuses a Windows drive workspace", { skip: !bashAvailable }, () => {
  const script = `WS="$(kherep_shell_path "$(kherep_env WORKSPACE)")"; kherep_validate_shell_path KHEREP_WORKSPACE "$WS"`;
  const result = shell(script, { KHEREP_PROFILE: "mac", KHEREP_WORKSPACE: "D:/Work" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /absolute forward-slash path/);
});

test("the commit-msg hook recognises a repository under the native workspace", { skip: process.platform !== "win32" || !bashAvailable }, (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-native-hook-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: repo }).status, 0);
  const message = path.join(repo, "COMMIT_EDITMSG");
  fs.writeFileSync(message, "fix: missing work item\n");
  const hook = path.resolve(import.meta.dirname, "..", "claude", "kherep", "githooks", "commit-msg").replace(/\\/g, "/");
  const workspace = workspaceEnvPath("win", root, "win32");
  assert.match(workspace, /^[A-Z]:\//);
  const result = spawnSync("sh", [hook, message.replace(/\\/g, "/")], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, KHEREP_WORKSPACE: workspace, KHEREP_WORK_ITEM_REQUIRED: "1" },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /requires the subject to start with the configured work-item key/);
});

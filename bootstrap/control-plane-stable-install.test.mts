// Issue #592. The control-plane commands of settings.json name the stable entry
// under CLAUDE_HOME, not the root an install runs from, so installs from two
// roots leave the same settings.json and only the pointer, source.json, follows
// the last install. A root the pointer no longer names can go; the root it names
// cannot: the stored commands then fail closed and drift-check reports why.
// Two copies of this source stand in for a checkout and a service source pin.
// Throwaway homes only; the host's KHEREP_* variables are dropped. Runs in a
// Windows CI shard of its own (ci-shard.mts): two installs under Git Bash.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const REPO = path.resolve(import.meta.dirname, "..");
const ENTRY = "kherep/control-plane/claude-control-plane-hook.mts";
const POINTER = "kherep/control-plane/source.json";
const PROFILE = process.platform === "darwin" ? "mac" : "win";
const forward = (value: string): string => value.replace(/\\/g, "/");
// Git Bash wants /c/... on Windows; install.sh refuses a drive-letter path.
const slash = (value: string): string =>
  forward(value).replace(/^([A-Za-z]):\//, (_match, drive: string) => `/${drive.toLowerCase()}/`);
const TYPE_STRIPPING_WARNING = new RegExp("^\\(node:\\d+\\) ExperimentalWarning: Type Stripping is an experimental "
  + "feature and might change at any time\\r?\\n\\(Use `node --trace-warnings \\.\\.\\.` to show where the warning was "
  + "created\\)\\r?\\n", "gm");
const quiet = (stderr: string): string => stderr.replace(TYPE_STRIPPING_WARNING, "");

// A copy of the source tree as an install would see it, without the git metadata.
function copySource(to: string): string {
  const skipped = new Set([".git", "node_modules"]);
  fs.cpSync(REPO, to, { recursive: true, filter: (from) => !skipped.has(path.relative(REPO, from).split(path.sep)[0]) });
  return to;
}

test("installs from two roots leave the same settings.json; the pointer follows the last install and fails closed without its root", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-issue592-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const claude = path.join(home, ".claude");
  const ws = path.join(root, "Kherep");
  for (const dir of [claude, ws]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(claude, "settings.json"), "{}\n");
  const checkout = copySource(path.join(root, "checkout", "kherep"));
  const pin = copySource(path.join(root, "control-plane", "service", "source-pins", "0123456789abcdef0123456789abcdef01234567"));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("KHEREP_"))),
    HOME: slash(home), CLAUDE_HOME: slash(claude), KHEREP_PROFILE: PROFILE, KHEREP_WORKSPACE: slash(ws),
    GIT_CONFIG_SYSTEM: path.join(root, "gitconfig-system"), GIT_CONFIG_GLOBAL: path.join(root, "gitconfig-global"),
    KHEREP_INSTALL_SKIP_GITCONFIG: "1", KHEREP_INSTALL_SKIP_KNOWLEDGE_SPACE: "1", KHEREP_INSTALL_SKIP_ATL_CREDENTIAL: "1",
    SKIP_SECRETS: "1", SKIP_DEPS: "1", KHEREP_CONFIG_DIR: path.join(root, "no-node"),
  };
  const bash = (args: string[], input?: string) => spawnSync("bash", args, { encoding: "utf8", env, input, timeout: 600_000 });
  const install = (source: string) => {
    const run = bash([slash(path.join(source, "bootstrap", "install.sh"))]);
    assert.equal(run.status, 0, `${source}\n${run.stdout}\n${run.stderr}`);
    return fs.readFileSync(path.join(claude, "settings.json"));
  };
  const pointerRoot = () => JSON.parse(fs.readFileSync(path.join(claude, POINTER), "utf8")).root as string;

  const fromCheckout = install(checkout);
  assert.equal(fs.realpathSync(pointerRoot()), fs.realpathSync(checkout));
  const fromPin = install(pin);
  assert.ok(fromPin.equals(fromCheckout), "settings.json differs between the installs from two roots");
  assert.equal(fs.realpathSync(pointerRoot()), fs.realpathSync(pin));
  assert.ok(fs.readFileSync(path.join(claude, ENTRY)).equals(fs.readFileSync(path.join(REPO, "claude", ENTRY))));

  const settings = JSON.parse(fromPin.toString("utf8")) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
  const deliver = settings.hooks.Stop.flatMap((group) => group.hooks).map((hook) => hook.command)
    .find((command) => command.includes("claude-control-plane-hook.mts\" deliver"));
  assert.ok(deliver, "no stable deliver command on Stop");
  const stop = JSON.stringify({ session_id: "s", hook_event_name: "Stop" });
  // The entry runs the hook in its own process as the main module: the hook's own argument check answers.
  const bogus = bash(["-c", `${deliver} --runtime bogus`], stop);
  assert.equal(bogus.status, 0, bogus.stderr);
  assert.match(quiet(bogus.stderr), /^kherep deliver-hook: unknown --runtime/m);

  // The root the pointer no longer names is free to go.
  fs.rmSync(checkout, { recursive: true, force: true });
  const kept = bash(["-c", deliver], stop);
  assert.deepEqual([kept.status, kept.stdout, quiet(kept.stderr)], [0, "", ""], kept.stderr);

  // The root it names is not: the stored command fails closed, drift-check says why.
  fs.rmSync(pin, { recursive: true, force: true });
  const failLine = /^kherep control-plane-hook: the pointer's source has no such hook; pointer [^\n]+source\.json; run bootstrap\/install\.sh\r?\n$/;
  const gone = bash(["-c", deliver], stop);
  assert.equal(gone.status, 1, gone.stderr);
  assert.equal(gone.stdout, "");
  assert.match(quiet(gone.stderr), failLine);
  const drift = bash([slash(path.join(REPO, "bootstrap", "drift-check.sh"))]);
  assert.equal(drift.status, 1, `${drift.stdout}\n${drift.stderr}`);
  assert.match(drift.stdout, /^POINTER-UNRESOLVED kherep\/control-plane\/source\.json \(missing-hook: [^\n]+\)\r?$/m, drift.stdout);

  // Without the pointer every stored command fails closed, and the pointer is missing live.
  fs.rmSync(path.join(claude, POINTER));
  const missing = bash(["-c", deliver], stop);
  assert.deepEqual([missing.status, missing.stdout], [1, ""], missing.stderr);
  assert.match(quiet(missing.stderr), /^kherep control-plane-hook: no control-plane source pointer; pointer /);
  const unpointed = bash([slash(path.join(REPO, "bootstrap", "drift-check.sh"))]);
  assert.equal(unpointed.status, 1, `${unpointed.stdout}\n${unpointed.stderr}`);
  assert.match(unpointed.stdout, /^MISSING-LIVE\s+kherep\/control-plane\/source\.json\r?$/m, unpointed.stdout);
});

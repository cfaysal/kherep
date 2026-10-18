import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Issue #503. The shell dispatcher names the stable entry point as its
// attribution argument. It runs every guard first, unchanged, then resolves the
// attribution hook through the pointer and calls it in-process with the payload
// it already read. A missing pointer costs attribution only: one stderr line,
// every guard ran, and the decision keeps its bytes.

const GUARDS = ["commit-guard", "deploy-guard", "main-checkout-guard"];
const PAYLOAD = { hook_event_name: "PreToolUse", session_id: "fixture-session", cwd: "/synthetic/cwd",
  tool_name: "shell_command", tool_input: { command: "git push origin main" } };

function fixture(t: import("node:test").TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shell-dispatch-stable-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "codex");
  const hookDir = path.join(home, "hooks", "kherep-maestro");
  fs.mkdirSync(hookDir, { recursive: true });
  for (const name of ["shell-checks", "hook-adapter"]) fs.copyFileSync(path.join(import.meta.dirname, `${name}.mts`), path.join(hookDir, `${name}.mts`));
  const entry = path.join(hookDir, "codex-control-plane-hook.mts");
  fs.copyFileSync(path.join(import.meta.dirname, "control-plane-hook.mts"), entry);
  const trace = path.join(root, "trace.jsonl");
  fs.writeFileSync(trace, "");
  const writeGuard = (guard: string, extra = ""): void => fs.writeFileSync(path.join(hookDir, `${guard}.mts`), `import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({guard:${JSON.stringify(guard)}})+'\\n');${extra}`);
  for (const guard of GUARDS) writeGuard(guard);
  const source = path.join(root, "source");
  const node = path.join(source, "modules", "control-plane", "node");
  fs.mkdirSync(node, { recursive: true });
  fs.writeFileSync(path.join(node, "attribution-hook.mts"), `import fs from 'node:fs';
export function handleAttributionHook(payload,runtime){fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({guard:'attribution',payload,runtime})+'\\n');}`);
  fs.writeFileSync(path.join(node, "config.mts"), "export const nodePaths=()=>({});");
  const pointer = path.join(home, "orchestra", "control-plane-source.json");
  fs.mkdirSync(path.dirname(pointer));
  fs.writeFileSync(pointer, JSON.stringify({ version: 1, root: source, kind: "checkout", verified: true }));
  const run = () => spawnSync(process.execPath, [path.join(hookDir, "shell-checks.mts"), entry, "attribution", "--runtime", "codex"], {
    input: JSON.stringify(PAYLOAD), encoding: "utf8", timeout: 20_000,
    env: { ...process.env, KHEREP_CONFIG_DIR: root, KHEREP_WORKSPACE: root, CODEX_HOME: path.join(root, "elsewhere") },
  });
  const rows = () => fs.readFileSync(trace, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { guard: string; payload?: unknown; runtime?: string });
  const reset = () => fs.writeFileSync(trace, "");
  const denyFromCommitGuard = (deny = true) => writeGuard("commit-guard", deny ? "process.stderr.write('synthetic deny'); process.exit(2);" : "");
  return { root, hookDir, entry, pointer, run, rows, reset, denyFromCommitGuard };
}

test("the shell dispatcher hands the full PreToolUse payload to the pointer's attribution hook", (t) => {
  const f = fixture(t);
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");
  const rows = f.rows();
  assert.deepEqual(rows.map((row) => row.guard), [...GUARDS, "attribution"]);
  assert.deepEqual(rows[3]!.payload, PAYLOAD);
  assert.equal(rows[3]!.runtime, "codex");
});

for (const failure of ["missing pointer", "invalid pointer", "throwing entry point"]) {
  test(`attribution fails alone and never changes the decision (${failure})`, (t) => {
    const f = fixture(t);
    f.denyFromCommitGuard();
    const intact = f.run();
    assert.equal(JSON.parse(intact.stdout).hookSpecificOutput.permissionDecision, "deny");
    f.reset();

    if (failure === "missing pointer") fs.rmSync(f.pointer);
    else if (failure === "invalid pointer") fs.writeFileSync(f.pointer, JSON.stringify({ version: 1, root: "relative", kind: "checkout", verified: true }));
    else fs.writeFileSync(f.entry, "throw new Error('synthetic entry failure');\n");
    const denied = f.run();

    assert.equal(denied.status, 0);
    assert.equal(denied.stdout, intact.stdout, "the guard's deny keeps its bytes");
    assert.match(denied.stderr, /kherep shell-checks: attribution could not complete\n$/);
    assert.deepEqual(f.rows().map((row) => row.guard), GUARDS, "every guard ran, in order; attribution did not");

    // Without a deny the call stays allowed: attribution never decides.
    f.denyFromCommitGuard(false);
    const allowed = f.run();
    assert.equal(allowed.status, 0);
    assert.equal(allowed.stdout, "");
    assert.match(allowed.stderr, /kherep shell-checks: attribution could not complete\n$/);
  });
}

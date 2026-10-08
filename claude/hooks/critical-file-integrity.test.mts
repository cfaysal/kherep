#!/usr/bin/env node
// Contract test for the critical-file-integrity SessionStart hook. Spawned with
// `node <hook>.mts` and a JSON payload on stdin, the command form the installed
// settings use, never imported.
//
// Everything happens inside one throwaway directory: CLAUDE_HOME, HOME and
// USERPROFILE point into it, and the "versioned source" the hook restores from
// is a fixture checkout in the same tree, reached through the payload cwd.
// Neither the real ~/.claude nor the real checkout is read or written.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const HOOK = path.join(import.meta.dirname, "critical-file-integrity.mts");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "critical-file-integrity-"));
after(() => {
  try { fs.rmSync(TMP, { force: true, recursive: true }); } catch { /* best effort */ }
});

const GOOD = "#!/usr/bin/env bash\n# fixture commit-msg\nexit 1\n";
const REL = path.join("kherep", "githooks", "commit-msg");
// Issue #325. The post-checkout hook is the second critical git hook. Its
// fixture is healthy unless a test says otherwise.
const POST_CHECKOUT = path.join("kherep", "githooks", "post-checkout");

interface Box {
  claude: string;
  live: string;
  workspace: string;
}

let seq = 0;

// A throwaway Claude home plus a fixture checkout under <workspace>/kherep that
// carries the versioned commit-msg the hook restores from.
function sandbox(live: string | null, postCheckout: string | null = GOOD): Box {
  const root = path.join(TMP, `case-${++seq}`);
  const claude = path.join(root, "home", ".claude");
  const workspace = path.join(root, "ws");
  const checkout = path.join(workspace, "kherep");
  fs.mkdirSync(path.join(checkout, "claude", "hooks"), { recursive: true });
  fs.mkdirSync(path.join(checkout, "claude", "kherep", "githooks"), { recursive: true });
  fs.writeFileSync(path.join(checkout, "claude", "kherep", "githooks", "commit-msg"), GOOD, "utf8");
  fs.writeFileSync(path.join(checkout, "claude", POST_CHECKOUT), GOOD, "utf8");
  const livePath = path.join(claude, REL);
  fs.mkdirSync(path.dirname(livePath), { recursive: true });
  if (live !== null) fs.writeFileSync(livePath, live, "utf8");
  if (postCheckout !== null) fs.writeFileSync(path.join(claude, POST_CHECKOUT), postCheckout, "utf8");
  return { claude, live: livePath, workspace };
}

function run(box: Box, input: string, workspace: string = box.workspace): { status: number | null; stdout: string } {
  const result = spawnSync(process.execPath, [HOOK], {
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      CLAUDE_HOME: box.claude,
      HOME: path.dirname(box.claude),
      USERPROFILE: path.dirname(box.claude),
      KHEREP_WORKSPACE: workspace,
    },
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout };
}

function session(box: Box): { status: number | null; context: string } {
  const { status, stdout } = run(box, JSON.stringify({ hook_event_name: "SessionStart", cwd: box.workspace }));
  const context = stdout.trim() ? String(JSON.parse(stdout).hookSpecificOutput.additionalContext) : "";
  return { status, context };
}

function journal(box: Box): Record<string, unknown>[] {
  const file = path.join(box.claude, ".cache", "hook-integrity", "incidents.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

test("a healthy commit-msg identical to its source stays silent", () => {
  const box = sandbox(GOOD);
  const { status, context } = session(box);
  assert.equal(status, 0);
  assert.equal(context, "");
  assert.equal(journal(box).length, 0);
});

test("a 0-byte commit-msg is reported, restored and proven at the target", () => {
  const box = sandbox("");
  const { status, context } = session(box);
  assert.equal(status, 0);
  assert.match(context, /ORCHESTRA CRITICAL-FILE-INTEGRITY/);
  assert.match(context, /0 bytes/);
  assert.match(context, /RESTORED from the repo, verified at the target/);
  assert.equal(fs.readFileSync(box.live, "utf8"), GOOD);
  if (process.platform !== "win32") assert.notEqual(fs.statSync(box.live).mode & 0o111, 0, "restored without the exec bit");
  const [entry] = journal(box);
  assert.equal(entry?.state, "DEFEKT");
  assert.equal(entry?.restoreProven, true);
  assert.equal(entry?.guard, "critical-file-integrity");
});

test("a swapped commit-msg is caught by content, not only by size, and restored", () => {
  const box = sandbox("#!/usr/bin/env bash\nexit 0\n");
  const { context } = session(box);
  assert.match(context, /content differs from source/);
  assert.match(context, /RESTORED/);
  assert.equal(fs.readFileSync(box.live, "utf8"), GOOD);
});

test("an absent commit-msg is reported and restored", () => {
  const box = sandbox(null);
  const { context } = session(box);
  assert.match(context, /not present on disk/);
  assert.equal(fs.readFileSync(box.live, "utf8"), GOOD);
});

test("without a checkout the hook says enforcement is off and claims no repair", () => {
  const box = sandbox("");
  const { status, stdout } = run(box, JSON.stringify({ hook_event_name: "SessionStart", cwd: path.join(TMP, "elsewhere") }), "");
  assert.equal(status, 0);
  const context = String(JSON.parse(stdout).hookSpecificOutput.additionalContext);
  assert.match(context, /NOT restored/);
  assert.match(context, /IS OFF/);
  assert.doesNotMatch(context, /RESTORED/);
  assert.equal(fs.readFileSync(box.live, "utf8"), "");
});

test("a 0-byte or absent post-checkout is reported and restored", () => {
  for (const live of ["", null]) {
    const box = sandbox(GOOD, live);
    const { status, context } = session(box);
    assert.equal(status, 0);
    assert.match(context, /kherep\/githooks\/post-checkout: .*RESTORED from the repo/);
    assert.doesNotMatch(context, /commit-msg/, "the healthy commit-msg is not reported");
    assert.equal(fs.readFileSync(path.join(box.claude, POST_CHECKOUT), "utf8"), GOOD);
  }
});

test("malformed stdin never breaks a session start", () => {
  const box = sandbox(GOOD);
  assert.equal(run(box, "not json").status, 0);
});

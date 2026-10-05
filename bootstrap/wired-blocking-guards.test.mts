// Issue #237, acceptance 4. The guards that emit a block decision still block
// after their move from .js to .mts, run exactly the way the installed settings
// run them: the command string from claude/settings.user.json, under the event
// it is wired to, with the Claude home placeholder resolved, executed through a
// shell. A guard whose wiring points
// at a missing file, or whose converted source no longer loads, exits without
// a decision; that is fail-open, and this test fails on it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const repo = path.resolve(import.meta.dirname, "..");
const claudeSource = path.join(repo, "claude").replace(/\\/g, "/");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wired-blocking-guards-"));
const WORKSPACE = path.join(TMP, "workspace");
fs.mkdirSync(WORKSPACE, { recursive: true });
after(() => {
  try { fs.rmSync(TMP, { force: true, recursive: true }); } catch { /* best effort */ }
});

interface HookCommand { command?: unknown }
interface HookEntry { hooks?: HookCommand[] }
interface Settings { hooks?: Record<string, HookEntry[]> }

const settings = JSON.parse(fs.readFileSync(path.join(repo, "claude", "settings.user.json"), "utf8")) as Settings;

interface Wired { event: string; command: string }

// The one wired command, in whichever event, that runs the named hook file.
function wiredCommand(hook: string): Wired {
  const found: Wired[] = [];
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    for (const entry of entries.flatMap((group) => group.hooks ?? [])) {
      if (typeof entry.command === "string" && entry.command.includes(`/hooks/${hook}`)) {
        found.push({ event, command: entry.command });
      }
    }
  }
  assert.equal(found.length, 1, `the settings template wires ${hook} exactly once`);
  return found[0]!;
}

function transcript(name: string, entries: unknown[]): string {
  const file = path.join(TMP, `${name}.jsonl`);
  fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  return file;
}

const user = (text: string) => ({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (text: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });

// Runs the wired command through a shell, the way Claude Code starts a hook.
function runWired({ event, command }: Wired, payload: Record<string, unknown>): { status: number | null; decision: unknown; stderr: string } {
  const resolved = command.replaceAll("__KHEREP_CLAUDE_HOME__", claudeSource);
  const result = spawnSync(resolved, {
    shell: true,
    encoding: "utf8",
    input: JSON.stringify({ hook_event_name: event, cwd: WORKSPACE, ...payload }),
    env: { ...process.env, KHEREP_WORKSPACE: WORKSPACE },
    windowsHide: true,
  });
  let decision: unknown = null;
  try {
    decision = (JSON.parse(result.stdout) as { decision?: unknown }).decision;
  } catch {
    decision = null;
  }
  return { status: result.status, decision, stderr: result.stderr };
}

// Both guards read the Stop payload (stop_hook_active, the finished turn), so
// Stop is the only event they may be wired to (#254): under PreToolUse the
// CLQ gate would judge a turn that is still running and block a tool call.
const GUARDS = [
  {
    hook: "clq-accept-gate.mts",
    event: "Stop",
    blocking: () => transcript("clq", [
      user("baue das"),
      assistant("Dispatched: 1 agents\nOutcomes: kherep-builder[opus] -> added retry\nEvidence: npm test 3/3\nNext: ship"),
    ]),
  },
  {
    hook: "maestro-banner-gate.mts",
    event: "Stop",
    blocking: () => transcript("banner", [user("wo stehen wir"), assistant("x".repeat(500))]),
  },
];

for (const guard of GUARDS) {
  test(`${guard.hook} is wired under ${guard.event} as an .mts file that exists`, () => {
    const { event, command } = wiredCommand(guard.hook);
    assert.equal(event, guard.event, `${guard.hook} is wired under ${event}`);
    assert.match(command, new RegExp(`^node "__KHEREP_CLAUDE_HOME__/hooks/${guard.hook.replace(".", "\\.")}"$`));
    assert.ok(fs.existsSync(path.join(repo, "claude", "hooks", guard.hook)), `claude/hooks/${guard.hook} exists`);
  });

  test(`${guard.hook} still blocks a blocking turn through its wired command`, () => {
    const { status, decision, stderr } = runWired(wiredCommand(guard.hook), { transcript_path: guard.blocking() });
    assert.equal(status, 0, stderr);
    assert.equal(decision, "block", `no block decision; stderr: ${stderr}`);
  });

  test(`${guard.hook} does not block its own continuation through its wired command`, () => {
    const { status, decision } = runWired(wiredCommand(guard.hook), {
      transcript_path: guard.blocking(),
      stop_hook_active: true,
    });
    assert.equal(status, 0);
    assert.equal(decision, null);
  });
}

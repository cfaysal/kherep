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

import { syntaxVerdict } from "../claude/hooks/lib/hook-syntax.mts";

const repo = path.resolve(import.meta.dirname, "..");
const claudeSource = path.join(repo, "claude").replace(/\\/g, "/");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wired-blocking-guards-"));
const WORKSPACE = path.join(TMP, "workspace");
fs.mkdirSync(WORKSPACE, { recursive: true });
after(() => {
  try { fs.rmSync(TMP, { force: true, recursive: true }); } catch { /* best effort */ }
});

interface HookCommand { command?: unknown }
interface HookEntry { matcher?: string; hooks?: HookCommand[] }
interface Settings { hooks?: Record<string, HookEntry[]> }

const settings = JSON.parse(fs.readFileSync(path.join(repo, "claude", "settings.user.json"), "utf8")) as Settings;

interface Wired { event: string; matcher: string; command: string }

// The one wired command, in whichever event, that runs the named hook file.
function wiredCommand(hook: string): Wired {
  const found: Wired[] = [];
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    for (const group of groups) {
      for (const entry of group.hooks ?? []) {
        if (typeof entry.command === "string" && entry.command.includes(`/hooks/${hook}`)) {
          found.push({ event, matcher: group.matcher ?? "", command: entry.command });
        }
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

interface Run { status: number | null; decision: unknown; permission: unknown; stderr: string }

// Runs the wired command through a shell, the way Claude Code starts a hook.
// claudeHome replaces the placeholder (default: this checkout's claude/), so a
// test can point the same command at a copy with a broken guard.
function runWired(
  { event, command }: Wired, payload: Record<string, unknown>,
  claudeHome = claudeSource, env: Record<string, string | undefined> = {},
): Run {
  const resolved = command.replaceAll("__KHEREP_CLAUDE_HOME__", claudeHome);
  const result = spawnSync(resolved, {
    shell: true,
    encoding: "utf8",
    input: JSON.stringify({ hook_event_name: event, cwd: WORKSPACE, ...payload }),
    env: { ...process.env, KHEREP_WORKSPACE: WORKSPACE, ...env },
    windowsHide: true,
  });
  let output: { decision?: unknown; hookSpecificOutput?: { permissionDecision?: unknown } } = {};
  try {
    output = JSON.parse(result.stdout) ?? {};
  } catch { /* no JSON on stdout */ }
  return {
    status: result.status,
    decision: output.decision ?? null,
    permission: output.hookSpecificOutput?.permissionDecision ?? null,
    stderr: result.stderr,
  };
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

// Issue #237 batch 2: the six PreToolUse guards. Three block with exit 2 and a
// stderr reason, three with a JSON deny on exit 0. Each case names a tool its
// wired matcher has to cover, including the tools of the legacy groups hosts
// still carry (see guard-matcher-coverage.test.mts).
type Mode = "exit2" | "deny";
interface ToolCase { tool: string; input: Record<string, unknown> }
const bash = (command: string, tool = "Bash"): ToolCase => ({ tool, input: { command } });
// Synthetic private markers, assembled so this file itself carries none.
const PRIVATE_FILE = `D:/Work-${"credentials"}/fixture.env`;
const PRIVATE_TAG = `<${"private"}>synthetic</${"private"}>`;
const PRETOOL_GUARDS: { hook: string; matcher: string; mode: Mode; blocking: ToolCase[]; benign: ToolCase }[] = [
  { hook: "commit-guard.mts", matcher: "Bash", mode: "exit2",
    blocking: [bash('git commit -m "x Co-Authored-By: bot"')], benign: bash('git commit -m "plain subject"') },
  { hook: "deploy-guard.mts", matcher: "Bash", mode: "exit2",
    blocking: [bash("git push --force")], benign: bash("git push origin main") },
  { hook: "secret-output-guard.mts", matcher: "", mode: "exit2",
    blocking: [bash("printenv"), bash("Get-ChildItem Env:", "PowerShell")], benign: bash("git status") },
  { hook: "privacy-boundary-guard.mts", matcher: "", mode: "deny",
    blocking: [
      { tool: "Read", input: { file_path: PRIVATE_FILE } },
      { tool: "mcp__rovo__search", input: { query: PRIVATE_TAG } },
    ],
    benign: { tool: "Read", input: { file_path: path.join(WORKSPACE, "src", "a.ts") } } },
  { hook: "dispatch-contract-guard.mts", matcher: "Agent|Task", mode: "deny",
    blocking: [{ tool: "Agent", input: { subagent_type: "kherep-builder", prompt: "build it" } }],
    benign: { tool: "Agent", input: { subagent_type: "general-purpose", model: "sonnet", prompt: "look it up" } } },
  { hook: "playwright-file-guard.mts", matcher: "", mode: "deny",
    blocking: [{ tool: "mcp__plugin_playwright_playwright__browser_navigate", input: { url: "file:///C:/report/index.html" } }],
    benign: { tool: "mcp__plugin_playwright_playwright__browser_navigate", input: { url: "http://localhost:8080/" } } },
];

// The host's own policy settings must not decide these cases.
const NEUTRAL_ENV = { KHEREP_WORK_ITEM_REQUIRED: "", KHEREP_ALLOWED_MODELS: undefined, KHEREP_AGENT_MODEL_POLICY: undefined };

function runCase(wired: Wired, item: ToolCase, claudeHome?: string): Run {
  return runWired(wired, { tool_name: item.tool, tool_input: item.input }, claudeHome, NEUTRAL_ENV);
}

function blocked(run: Run, mode: Mode, hook: string): boolean {
  return mode === "exit2"
    ? run.status === 2 && run.stderr.includes(hook.replace(".mts", ""))
    : run.status === 0 && run.permission === "deny";
}

// Asserts that the guard blocks every blocking case and lets the benign one pass.
function assertBlocks(guard: (typeof PRETOOL_GUARDS)[number], claudeHome?: string): void {
  const wired = wiredCommand(guard.hook);
  for (const item of guard.blocking) {
    const run = runCase(wired, item, claudeHome);
    assert.ok(blocked(run, guard.mode, guard.hook),
      `${guard.hook} did not block ${item.tool}: status ${run.status}, stderr ${run.stderr}`);
  }
  const run = runCase(wired, guard.benign, claudeHome);
  assert.equal(run.status, 0, `${guard.hook} benign: ${run.stderr}`);
  assert.equal(run.permission, null, `${guard.hook} denied a benign ${guard.benign.tool}`);
}

for (const guard of PRETOOL_GUARDS) {
  test(`${guard.hook} is wired under PreToolUse "${guard.matcher}" as an .mts file that exists`, async () => {
    const { event, matcher, command } = wiredCommand(guard.hook);
    assert.equal(event, "PreToolUse");
    assert.equal(matcher, guard.matcher);
    assert.match(command, new RegExp(`^node "__KHEREP_CLAUDE_HOME__/hooks/${guard.hook.replace(".", "\\.")}"$`));
    const file = path.join(repo, "claude", "hooks", guard.hook);
    assert.ok(fs.statSync(file).size > 0, `claude/hooks/${guard.hook} is not empty`);
    // live-hook-integrity.mts calls a hook DEFEKT when Node's parser rejects it.
    // `node --check` cannot say so for .mts (issue #278); lib/hook-syntax.mts can.
    const verdict = await syntaxVerdict(file, fs.readFileSync(file, "utf8"));
    assert.equal(verdict.state, "OK", `Node's parser rejects ${guard.hook}: ${JSON.stringify(verdict)}`);
  });

  test(`${guard.hook} still blocks through its wired command and allows a benign call`, () => {
    assertBlocks(guard);
  });
}

// Red-first evidence kept as a test: the same checks fail for a 0-byte or a
// missing guard, so a conversion that leaves a guard unable to run cannot pass.
test("a 0-byte or missing PreToolUse guard fails the blocking checks", () => {
  const copy = path.join(TMP, "broken-claude");
  fs.cpSync(path.join(repo, "claude", "hooks"), path.join(copy, "hooks"), { recursive: true });
  const home = copy.replace(/\\/g, "/");
  for (const guard of PRETOOL_GUARDS) {
    const file = path.join(copy, "hooks", guard.hook);
    const original = fs.readFileSync(file);
    assertBlocks(guard, home);
    fs.writeFileSync(file, "");
    assert.throws(() => assertBlocks(guard, home), assert.AssertionError, `0-byte ${guard.hook}`);
    fs.rmSync(file);
    assert.throws(() => assertBlocks(guard, home), assert.AssertionError, `missing ${guard.hook}`);
    fs.writeFileSync(file, original);
  }
});

// Red-first evidence for the syntax assertion above: a 0-byte guard and one with
// an ESM syntax error must not pass it. `node --check` passes both (issue #278).
test("the syntax assertion rejects a 0-byte guard and an ESM syntax error", async () => {
  for (const guard of PRETOOL_GUARDS) {
    const file = path.join(TMP, "syntax", guard.hook);
    for (const source of ["", "export const x = ;\n"]) {
      const verdict = await syntaxVerdict(file, source);
      assert.equal(verdict.state, "DEFEKT", `${guard.hook} with ${JSON.stringify(source)}: ${JSON.stringify(verdict)}`);
    }
  }
});

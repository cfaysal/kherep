// Shared fixture of the Codex denied-call suites (issue #504): a temporary Codex home laid out as an
// installation, <home>/hooks/kherep-maestro with both adapter copies and their modules (copyAdapter), the shell dispatcher, synthetic
// guards and the journal lib beside them, as codex/install.mts installs claude/hooks/lib there.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { copyAdapter } from "./hook-adapter.fixture.mts";

const roots: string[] = [];
const CLAUDE_LIB = path.resolve(import.meta.dirname, "..", "..", "claude", "hooks", "lib");
export const JOURNAL_LIBS = ["denial-journal.mts", "workspace-scope.mts"];

export interface CodexHome { root: string; hookDir: string }

// lib: the state of the installed journal lib.
export function codexHome(guards: Record<string, string>, lib: "present" | "missing" | "empty" | "throwing" | "hanging" = "present"): CodexHome {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-denials-")));
  roots.push(root);
  const hookDir = path.join(root, "hooks", "kherep-maestro");
  fs.mkdirSync(path.join(hookDir, "lib"), { recursive: true });
  for (const name of ["codex-hook-adapter.mts", "hook-adapter.mts"]) copyAdapter(hookDir, name);
  fs.copyFileSync(path.join(import.meta.dirname, "shell-checks.mts"), path.join(hookDir, "codex-shell-checks.mts"));
  for (const [name, source] of Object.entries(guards)) fs.writeFileSync(path.join(hookDir, name), source);
  if (lib !== "missing") for (const name of JOURNAL_LIBS) fs.copyFileSync(path.join(CLAUDE_LIB, name), path.join(hookDir, "lib", name));
  const target = path.join(hookDir, "lib", "denial-journal.mts");
  if (lib === "empty") fs.writeFileSync(target, "");
  if (lib === "throwing") fs.writeFileSync(target, "export function journalVerdict() { throw new Error(\"boom\"); }\n");
  if (lib === "hanging") fs.writeFileSync(target, "export function journalVerdict() { return new Promise(() => {}); }\n");
  return { root, hookDir };
}

export function cleanupHomes(): void {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
}

export interface Run { status: number | null; stdout: string; stderr: string; ms: number }

export function run(args: string[], input: string, env: NodeJS.ProcessEnv = process.env): Promise<Run> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ...args], { windowsHide: true, env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr, ms: Date.now() - start }));
    child.stdin.end(input);
  });
}

export const shellPayload = (extra: Record<string, unknown> = {}): string => JSON.stringify({ hook_event_name: "PreToolUse",
  tool_name: "shell_command", tool_input: { command: "git push origin" }, cwd: "/w", agent_id: "agent-c1", tool_use_id: "call_1", ...extra });

export const exit2 = (tag: string): string => `process.stderr.write("[${tag}] ${tag} says no\\n");\nprocess.exit(2);\n`;

// A run's stdout with its fixture directory's name (codex-denials-<random>) replaced, so runs in
// two homes compare whatever spelling of the temp root precedes it (on Windows an 8.3 short form).
export const scrub = (stdout: string, home: CodexHome): string => stdout.replaceAll(path.basename(home.root), "<fixture>");

// Two runs in two homes gave the same answer: the decision part byte for byte, the whole document after scrub.
export function assertSameAnswer(result: Run, home: CodexHome, reference: Run, referenceHome: CodexHome): void {
  const decision = (stdout: string): string => JSON.stringify((JSON.parse(stdout) as { hookSpecificOutput?: unknown }).hookSpecificOutput);
  assert.equal(decision(result.stdout), decision(reference.stdout), "the decision part is byte-equal");
  assert.equal(scrub(result.stdout, home), scrub(reference.stdout, referenceHome));
}

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SHELL_TOOLS = new Set(["Bash", "shell_command", "exec_command", "functions.exec"]);
const PATCH_TOOLS = new Set(["apply_patch", "Edit", "Write", "MultiEdit"]);

// A Codex hook payload as it arrives on stdin. tool_input is a string for
// functions.exec and apply_patch, an object for the shell and file tools.
export interface HookPayload {
  tool_name?: unknown;
  tool_input?: unknown;
  cwd?: string;
  transcript_path?: string | null;
  [key: string]: unknown;
}

export function inputText(input: unknown): string {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  for (const key of ["command", "source", "code", "input", "patch"]) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return JSON.stringify(input);
}

function decodeStringLiteral(literal: string): string {
  if (literal.startsWith('"')) {
    try { return JSON.parse(literal); } catch { return ""; }
  }
  return literal.slice(1, -1)
    .replace(/\\'/g, "'")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\\\/g, "\\");
}

export function shellCommandsFromExec(source: unknown): string[] {
  const commands: string[] = [];
  const pattern = /tools\.shell_command\s*\(\s*\{[\s\S]{0,500}?\bcommand\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g;
  for (const match of String(source || "").matchAll(pattern)) {
    const command = decodeStringLiteral(match[1]);
    if (command) commands.push(command);
  }
  return commands;
}

export function normalizeDeployApproval(payload: HookPayload): HookPayload {
  const input = payload.tool_input;
  const command = input && typeof input === "object" ? (input as Record<string, unknown>).command : undefined;
  if (typeof command !== "string") return payload;
  const powershell = /\$env:KHEREP_DEPLOY_AUTH\s*=\s*['"]approved['"]\s*;/i;
  if (!powershell.test(command)) return payload;
  return { ...payload, tool_input: { ...(input as Record<string, unknown>), command: `KHEREP_DEPLOY_AUTH=approved ${command}` } };
}

export function patchPaths(text: unknown, cwd?: string): string[] {
  const source = String(text || "").replace(/\\r\\n|\\n/g, "\n");
  const found: string[] = [];
  const pattern = /\*\*\* (?:Add|Update|Delete) File:\s*([^\r\n"']+)/g;
  for (const match of source.matchAll(pattern)) {
    const value = match[1].trim().replace(/\\\\/g, "\\");
    const target = path.isAbsolute(value) ? value : path.resolve(cwd || process.cwd(), value);
    if (!found.includes(target)) found.push(target);
  }
  return found;
}

export function normalizePayloads(payload: HookPayload, phase = "pre"): HookPayload[] {
  const tool = String(payload.tool_name || "");
  const text = inputText(payload.tool_input);
  if (phase === "post" && (PATCH_TOOLS.has(tool) || tool === "functions.exec")) {
    const paths = patchPaths(text, payload.cwd);
    if (paths.length) return paths.map((filePath) => ({
      ...payload,
      tool_name: "Edit",
      tool_input: { file_path: filePath, new_string: text },
    }));
  }
  if (SHELL_TOOLS.has(tool)) {
    let commands = tool === "functions.exec" ? shellCommandsFromExec(text) : [];
    if (tool === "functions.exec" && phase === "pre-privacy") {
      const toolCallCount = (text.match(/\btools\.[A-Za-z0-9_]+/g) || []).length;
      if (commands.length !== 1 || toolCallCount !== 1) commands = [];
    }
    const base = typeof payload.tool_input === "object" && payload.tool_input !== null ? payload.tool_input : {};
    return (commands.length ? commands : [text]).map((command) => ({
      ...payload,
      tool_name: "Bash",
      tool_input: { ...base, command },
    }));
  }
  if (PATCH_TOOLS.has(tool)) return [{ ...payload, tool_name: tool === "apply_patch" ? "Edit" : tool }];
  if (["spawn_agent", "Agent", "Task"].includes(tool)) return [{ ...payload, tool_name: "Agent" }];
  return [payload];
}

function main(): void {
  const target = process.argv[2];
  const phase = process.argv[3] || "pre";
  if (!target || !path.isAbsolute(target)) process.exit(0);
  let payload: HookPayload;
  try { payload = JSON.parse(fs.readFileSync(0, "utf8")); } catch { process.exit(0); }
  for (const item of normalizePayloads(payload, phase)) {
    const normalized = phase === "pre-no-transcript"
      ? normalizeDeployApproval({ ...item, transcript_path: null }) : item;
    const result = spawnSync(process.execPath, [target], {
      encoding: "utf8",
      input: JSON.stringify(normalized),
      windowsHide: true,
    });
    if (result.stdout) {
      process.stdout.write(result.stdout);
      if (phase === "pre-privacy") return;
    }
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status && result.status !== 0) process.exit(result.status);
  }
}

// Node loads the main module from its real path, so a script started through a
// symlinked directory (macOS /var -> /private/var) only matches after realpath.
// It needs no main flag on import.meta, which Node 23 and 24.0-24.1 lack.
function isMainModule(): boolean {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] || "")).href;
  } catch {
    return false;
  }
}

if (isMainModule()) main();

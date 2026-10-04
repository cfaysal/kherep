import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Check } from "./doctor-local.mts";

// The hook check of `kherep-node doctor` (issue #215): whether the delivery
// and wake hook commands in Claude settings.json and Codex config.toml name
// this checkout. Only hook command fields are read, never permissions or other
// settings, and only the matched script path is reported.

const HOOK = String.raw`modules[\\/]+control-plane[\\/]+node[\\/]+(?:deliver|wake)-hook\.mts`;
const START = String.raw`(?:[A-Za-z]:[\\/]|[\\/]|~[\\/])`;
// A quoted path may hold spaces; an unquoted one ends at whitespace and must
// start a word, so a command prefix or an inline VAR=value never joins it.
const HOOK_PATH = new RegExp(String.raw`(["'])(${START}[^"'\n]*?${HOOK})\1|(?:^|[\s=])(${START}[^\s"']*?${HOOK})(?=$|[\s;&|])`, "g");

export function hookPaths(command: string): string[] {
  return [...command.matchAll(HOOK_PATH)].map((match) => match[2] ?? match[3]);
}

// Claude settings: hooks.<event>[].hooks[].command.
function claudeCommands(text: string): string[] {
  const hooks = (JSON.parse(text) as { hooks?: unknown }).hooks;
  if (typeof hooks !== "object" || hooks === null) return [];
  return Object.values(hooks).flat().flatMap((group: unknown) => {
    const list = (group as { hooks?: unknown } | null)?.hooks;
    return Array.isArray(list) ? list.map((hook: { command?: unknown } | null) => hook?.command) : [];
  }).filter((command): command is string => typeof command === "string");
}

// Codex config: command and commandWindows keys inside [hooks.*] or
// [[hooks.*]] tables, as TOML basic strings (JSON-compatible escapes).
function codexCommands(text: string): string[] {
  const commands: string[] = [];
  let inHooks = false;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*$/.exec(line);
    if (header) { inHooks = /^hooks\./.test(header[1]); continue; }
    const entry = inHooks ? /^\s*command(?:Windows)?\s*=\s*("(?:[^"\\]|\\.)*")\s*$/.exec(line) : null;
    if (!entry) continue;
    try { commands.push(JSON.parse(entry[1]) as string); } catch { /* not a JSON-compatible string */ }
  }
  return commands;
}

function realOrResolved(file: string): string {
  const expanded = /^~[\\/]/.test(file) ? path.join(os.homedir(), file.slice(2)) : file;
  try { return fs.realpathSync.native(expanded); } catch { return path.resolve(expanded); }
}

type HookScan = { present: boolean; deliver: number; wake: number; foreign: string[] };

function scanHooks(file: string, repoRoot: string, commandsOf: (text: string) => string[]): HookScan | null {
  let commands: string[];
  try {
    commands = commandsOf(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { present: false, deliver: 0, wake: 0, foreign: [] };
    return null;
  }
  const counts = { deliver: 0, wake: 0 };
  const foreign = new Set<string>();
  for (const found of commands.flatMap(hookPaths)) {
    const kind = /deliver-hook\.mts$/.test(found) ? "deliver" : "wake";
    const expected = path.join(repoRoot, "modules", "control-plane", "node", `${kind}-hook.mts`);
    if (realOrResolved(found) === realOrResolved(expected)) counts[kind]++;
    else foreign.add(found);
  }
  return { present: true, ...counts, foreign: [...foreign] };
}

// ok: at least one hook is installed and every hook command names this checkout.
export function checkHooks(files: { claude: string; codex: string }, repoRoot: string): Check {
  const claude = scanHooks(files.claude, repoRoot, claudeCommands);
  const codex = scanHooks(files.codex, repoRoot, codexCommands);
  if (!claude || !codex) return { ok: false, detail: "a runtime configuration file is unreadable" };
  const foreign = claude.foreign.length + codex.foreign.length;
  const total = claude.deliver + claude.wake + codex.deliver + codex.wake + foreign;
  let detail: string | undefined;
  if (foreign > 0) detail = "a hook command names another checkout";
  else if (total === 0) detail = "no delivery or wake hook is installed";
  return { ok: foreign === 0 && total > 0, checkout: repoRoot, claude, codex, ...(detail ? { detail } : {}) };
}

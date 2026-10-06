import fs from "node:fs";
import path from "node:path";

import { ensureDir } from "./config.mts";
import { readJson, writeJsonAtomic } from "./inbox.mts";
import { MAX_ANCESTORS, readProcessTable, type ProcessTable } from "./launch-mode.mts";

// Whether a Claude Code session runs headless (claude -p), so that it can
// never be woken and the wake hook ends its listener before the first poll
// (issue #235, operator decisions of 2026-10-05). Fail open: "headless" only on
// a positive signal; "interactive" and "unknown" keep the listener.
// One process listing (launch-mode.mts) gives the first Claude Code process
// among MAX_ANCESTORS up from the hook's parent; the walk ends there, so a -p
// above it (Windows Terminal takes -p <profile>) never counts. In this order:
// 1. A process of the --bg machinery, or one whose parent is, is interactive,
//    whatever its environment: the daemon's task and intercom sessions may
//    inherit CLAUDE_CODE_ENTRYPOINT. Measured 2026-10-05: on Windows a --bg
//    session runs under claude --bg-pty-host and takes its prompt as an
//    argument; on macOS the session is claude bg-spare (no id, name or prompt)
//    under claude bg-pty-host under claude.exe daemon run. No --session-id is
//    relied on.
// 2. CLAUDE_CODE_ENTRYPOINT sdk-cli, as measured for claude -p, is headless;
//    claude --bg reports cli. Any other value decides nothing, never
//    interactive, because a claude -p started inside a session inherits it.
// 3. The Claude Code process's own options: -p or --print, a whole argument
//    before any --, is headless, else interactive. No Claude Code process, a
//    missing parent or a command line that cannot be read is unknown.
// Windows command lines are split as Windows does (windowsArgv), so a -p
// inside a quoted prompt is no option. ps on macOS and Linux loses the
// quoting: there a session outside the --bg machinery whose prompt holds a
// separate -p or --print is taken for headless (known false positive).
// Kept per Claude Code process (issues #245, #248), so only its first hook
// lists processes: <cache dir>/<session id>.<pid>.json holds the mode,
// CLAUDE_CODE_ENTRYPOINT and the time, written atomically, and decides only for
// the same three within RUN_MODE_MAX_AGE_MS. The pid is CLAUDE_PID, which
// Claude Code sets for its subprocesses (undocumented) and which survives a
// shell between Claude Code and the hook (Git Bash on Windows); a claude -p
// started inside a session sets its own (measured 2026-10-06 on macOS and
// Windows). Without a plain pid above 1 there, the hook's parent pid stands
// in; when that parent is a shell, every hook has its own, so nothing is kept
// or pruned and each hook checks in full. A claude -p --resume of an
// interactive session runs in another process, so it gets its own full check.
// Only a full check that found the Claude Code process and read its parent's
// command line is kept; any read or write error means a full check.

export type RunMode = "interactive" | "headless" | "unknown";

export const RUN_MODE_MAX_AGE_MS = 60 * 60_000;
const CLAUDE_PROGRAM = /^claude(\.exe|\.cmd)?$/i;
const NODE_PROGRAM = /^node(\.exe)?$/i;
const CLAUDE_SCRIPT = /@anthropic-ai[\\/]claude-code[\\/](cli\.js|bin[\\/]claude)/;
const PLAIN_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PLAIN_PID = /^[1-9]\d{0,9}$/;
const SHELL_PROGRAM = /^-?(bash|sh|zsh|dash|cmd|pwsh|powershell)(\.exe)?$/i;
const isPrint = (token: string): boolean => token === "-p" || token === "--print" || token.startsWith("--print=");
// The --bg machinery: a --bg-pty-host option (Windows), or the subcommand of
// the daemon, the PTY host and the spare session it runs (macOS, measured
// 2026-10-05: claude.exe daemon run, claude bg-pty-host, claude bg-spare).
// As ps loses the quoting, claude "daemon foo" -p reads like a subcommand
// (issue #245): never with -p or --print among the own options, the daemon
// only as daemon run, and its --spawned-by JSON, split by ps too, is no option.
const BG_HOST = "--bg-pty-host";
const BG_COMMANDS = new Set(["daemon run", "bg-pty-host", "bg-spare"]);
function backgroundOf(options: string[] | null): boolean {
  if (options === null) return false;
  const end = options.indexOf("--spawned-by");
  const own = end < 0 ? options : options.slice(0, end);
  const command = options.slice(0, options[0] === "daemon" ? 2 : 1).join(" ");
  return !own.some(isPrint) && (own.includes(BG_HOST) || BG_COMMANDS.has(command));
}

export interface HeadlessDeps {
  env?: Record<string, string | undefined>; processTable?: () => Promise<ProcessTable | null>; ppid?: number;
  platform?: NodeJS.Platform; cache?: { dir: string; sessionId: string }; now?: () => number;
}

export const entrypointMode = (env: Record<string, string | undefined>): RunMode =>
  env.CLAUDE_CODE_ENTRYPOINT === "sdk-cli" ? "headless" : "unknown";

// Windows command-line splitting, from "CommandLineToArgvW function" and
// "Parsing C command-line arguments" (learn.microsoft.com, fetched 2026-10-05):
// leading whitespace makes the first argument empty; argv[0] runs to the first
// whitespace outside quotes, the quotes dropped, without backslash rules. After
// it, 2n backslashes and a quote give n backslashes and toggle quoting, 2n+1
// give n and a literal quote, other backslashes are literal. Within a quoted
// string a pair of quotes is one literal quote and the string goes on (the C
// runtime rule; the CommandLineToArgvW page does not cover the pair).
export function windowsArgv(line: string): string[] {
  let at = 0;
  let program = "";
  for (let quotedName = false; at < line.length; at++) {
    const char = line[at];
    if (char === "\"") quotedName = !quotedName;
    else if (!quotedName && (char === " " || char === "\t")) break;
    else program += char;
  }
  const args = line === "" ? [] : [program];
  let current: string | null = null;
  let quoted = false;
  for (; at < line.length; at++) {
    const char = line[at];
    if (!quoted && (char === " " || char === "\t")) {
      if (current !== null) args.push(current);
      current = null;
      continue;
    }
    current ??= "";
    if (char === "\\") {
      let run = 0;
      while (line[at + run] === "\\") run++;
      at += run - 1;
      if (line[at + 1] !== "\"") {
        current += "\\".repeat(run);
        continue;
      }
      current += "\\".repeat(Math.floor(run / 2));
      at++;
      if (run % 2 === 1) {
        current += "\"";
        continue;
      }
    } else if (char !== "\"") {
      current += char;
      continue;
    }
    // At a quote that toggles, or at "" inside quotes.
    if (quoted && line[at + 1] === "\"") {
      current += "\"";
      at++;
    } else quoted = !quoted;
  }
  if (current !== null) args.push(current);
  return args;
}

const baseName = (token: string): string => token.replace(/^["']|["']$/g, "").split(/[\\/]/).at(-1) ?? "";

// The arguments after the Claude Code program, or null when the command line
// is not Claude Code's: claude itself, node running its npm script, or the
// package's own script path.
function claudeOptions(argv: string[]): string[] | null {
  const program = baseName(argv[0] ?? "");
  let at = CLAUDE_PROGRAM.test(program) ? 0 : argv.findIndex((token) => CLAUDE_SCRIPT.test(token));
  if (at < 0 && NODE_PROGRAM.test(program)) {
    const script = argv.findIndex((token, index) => index > 0 && !token.startsWith("-"));
    if (script > 0 && CLAUDE_PROGRAM.test(baseName(argv[script]))) at = script;
  }
  if (at < 0) return null;
  const rest = argv.slice(at + 1);
  const end = rest.indexOf("--");
  return end < 0 ? rest : rest.slice(0, end);
}

interface ClaudeProcess { background: boolean; print: boolean; parentRead: boolean }

const splitArgs = (args: string, platform: NodeJS.Platform): string[] =>
  platform === "win32" ? windowsArgv(args) : args.trim().split(/\s+/);

// The first Claude Code process up from ppid: background when it or its
// parent belongs to the --bg machinery, else print when it has the option;
// null when none is found or a command line on the way cannot be read.
function claudeProcess(ppid: number, table: ProcessTable, platform: NodeJS.Platform): ClaudeProcess | null {
  const split = (args: string): string[] => splitArgs(args, platform);
  let pid = ppid;
  for (let depth = 0; depth < MAX_ANCESTORS && pid > 1; depth++) {
    const entry = table.get(pid);
    if (!entry || entry.args === null) return null;
    const options = claudeOptions(split(entry.args));
    if (options) {
      const parent = table.get(entry.ppid)?.args;
      const parentRead = typeof parent === "string";
      const background = backgroundOf(options) || (parentRead && backgroundOf(claudeOptions(split(parent))));
      return { background, print: !background && options.some(isPrint), parentRead };
    }
    pid = entry.ppid;
  }
  return null;
}

// Step 3: print is never set on a background process (step 1).
function optionsMode(found: ClaudeProcess | null): RunMode {
  if (!found) return "unknown";
  return found.print ? "headless" : "interactive";
}

// Steps 1 and 3 alone, for a known listing.
export function ancestryMode(ppid: number, table: ProcessTable, platform: NodeJS.Platform = process.platform): RunMode {
  return optionsMode(claudeProcess(ppid, table, platform));
}

interface KeptMode { mode: RunMode; entrypoint: string; at: number }

function readKept(file: string, entrypoint: string, now: number): RunMode | null {
  try {
    const kept = readJson<KeptMode>(file);
    if (kept === null || kept.entrypoint !== entrypoint) return null;
    if (kept.mode !== "interactive" && kept.mode !== "headless") return null;
    const age = now - (kept.at ?? Number.NaN);
    return age >= 0 && age < RUN_MODE_MAX_AGE_MS ? kept.mode : null;
  } catch {
    return null;
  }
}

// Writes the entry after pruning entries (and stray temporary files) older than the bound.
function keep(file: string, kept: KeptMode): void {
  try {
    const dir = path.dirname(file);
    ensureDir(dir);
    for (const name of fs.readdirSync(dir)) {
      const entry = path.join(dir, name);
      try {
        if (kept.at - fs.statSync(entry).mtimeMs >= RUN_MODE_MAX_AGE_MS) fs.rmSync(entry, { force: true });
      } catch {
        // removed meanwhile
      }
    }
    writeJsonAtomic(file, kept);
  } catch {
    // not kept: the next hook checks in full
  }
}

export async function headlessMode(deps: HeadlessDeps = {}): Promise<RunMode> {
  const env = deps.env ?? process.env;
  const ppid = deps.ppid ?? process.ppid;
  const now = deps.now ?? Date.now;
  const platform = deps.platform ?? process.platform;
  const entrypoint = env.CLAUDE_CODE_ENTRYPOINT ?? "";
  const { cache } = deps;
  // Claude Code's own pid survives a shell between it and the hook (issue #248); else the hook's parent stands in.
  const claudePid = env.CLAUDE_PID ?? "";
  const ownPid = PLAIN_PID.test(claudePid) && Number(claudePid) > 1;
  const key = ownPid ? claudePid : ppid > 1 ? String(ppid) : null;
  const file = cache && key !== null && PLAIN_ID.test(cache.sessionId) ? path.join(cache.dir, `${cache.sessionId}.${key}.json`) : null;
  const kept = file === null ? null : readKept(file, entrypoint, now());
  if (kept !== null) return kept;
  const table = await (deps.processTable ?? (() => readProcessTable(deps.platform)))();
  const found = table ? claudeProcess(ppid, table, platform) : null;
  let mode: RunMode;
  if (found?.background) mode = "interactive";
  else if (entrypointMode(env) === "headless") mode = "headless";
  else mode = optionsMode(found);
  // A shell parent's pid comes back for no other hook: nothing to keep, nothing to prune.
  const parent = table?.get(ppid)?.args;
  const shellParent = !ownPid && typeof parent === "string" && SHELL_PROGRAM.test(baseName(splitArgs(parent, platform)[0] ?? ""));
  if (file !== null && found?.parentRead && !shellParent) keep(file, { mode, entrypoint, at: now() });
  return mode;
}

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

export type RunMode = "interactive" | "headless" | "unknown";

const CLAUDE_PROGRAM = /^claude(\.exe|\.cmd)?$/i;
const NODE_PROGRAM = /^node(\.exe)?$/i;
const CLAUDE_SCRIPT = /@anthropic-ai[\\/]claude-code[\\/](cli\.js|bin[\\/]claude)/;
// The --bg machinery: a --bg-pty-host option (Windows), or the subcommand of
// the daemon, the PTY host and the spare session it runs (macOS, measured
// 2026-10-05: claude.exe daemon run, claude bg-pty-host, claude bg-spare).
const BG_HOST = "--bg-pty-host";
const BG_COMMANDS = new Set(["daemon", "bg-pty-host", "bg-spare"]);
const backgroundOf = (options: string[] | null): boolean => options !== null && (options.includes(BG_HOST) || BG_COMMANDS.has(options[0]));

export interface HeadlessDeps {
  env?: Record<string, string | undefined>; processTable?: () => Promise<ProcessTable | null>; ppid?: number;
  platform?: NodeJS.Platform;
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

interface ClaudeProcess { background: boolean; print: boolean }

// The first Claude Code process up from ppid: background when it or its
// parent belongs to the --bg machinery, else print when it has the option;
// null when none is found or a command line on the way cannot be read.
function claudeProcess(ppid: number, table: ProcessTable, platform: NodeJS.Platform): ClaudeProcess | null {
  const split = (args: string): string[] => platform === "win32" ? windowsArgv(args) : args.trim().split(/\s+/);
  let pid = ppid;
  for (let depth = 0; depth < MAX_ANCESTORS && pid > 1; depth++) {
    const entry = table.get(pid);
    if (!entry || entry.args === null) return null;
    const options = claudeOptions(split(entry.args));
    if (options) {
      const parent = table.get(entry.ppid)?.args;
      const background = backgroundOf(options) || (parent !== undefined && parent !== null && backgroundOf(claudeOptions(split(parent))));
      return { background, print: !background && options.some((token) => token === "-p" || token === "--print" || token.startsWith("--print=")) };
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

export async function headlessMode(deps: HeadlessDeps = {}): Promise<RunMode> {
  const table = await (deps.processTable ?? (() => readProcessTable(deps.platform)))();
  const found = table ? claudeProcess(deps.ppid ?? process.ppid, table, deps.platform ?? process.platform) : null;
  if (found?.background) return "interactive";
  if (entrypointMode(deps.env ?? process.env) === "headless") return "headless";
  return optionsMode(found);
}

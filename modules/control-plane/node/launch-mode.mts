import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Whether a Claude Code session may run in bypassPermissions, judged from what
// the node can read when a SessionStart input carries no permission_mode
// (issue #97, operator decision of 2026-09-27; measured on Claude Code
// 2.1.258). Fail closed: "ok" only when nothing points to bypass and every
// source was read; "bypass" when one does; "unknown" otherwise.
// - Settings layers: permissions.defaultMode of the user settings (the
//   CLAUDE_CONFIG_DIR the hook inherits, else ~/.claude) and of the project and
//   local settings under the session cwd. A missing file is no layer; an
//   unreadable or unparseable one is unknown.
// - Launch flags: the command lines of up to MAX_ANCESTORS processes up from
//   the hook's parent. --dangerously-skip-permissions and bypassPermissions
//   anywhere (--permission-mode, inline --settings JSON) are bypass; --settings
//   with a file names its own defaultMode, so it is unknown. One process
//   listing, taken without any pid
//   in a command string. A pid missing from it has exited, and the Claude Code
//   process running the hook cannot have, so the walk ends there; a listing
//   that cannot be taken, a missing parent, or a command line that cannot be
//   read is unknown.

export type LaunchVerdict = "ok" | "bypass" | "unknown";
export type ProcessTable = Map<number, { ppid: number; args: string | null }>;
export type RunFile = (file: string, args: string[]) => Promise<string>;

export const MAX_ANCESTORS = 4;
const LIST_TIMEOUT_MS = 10_000;
// bypassPermissions anywhere covers --permission-mode bypassPermissions in all
// its spellings and an inline --settings JSON that sets it as defaultMode.
const BYPASS_FLAG = /(?:^|[\s"'])--dangerously-skip-permissions(?=$|[\s"'])|bypassPermissions/;
// --settings with a file rather than inline JSON. Measured 2026-09-27: the
// Claude desktop app (Windows) starts claude with --settings "{...}" and
// --permission-mode.
const SETTINGS_FILE = /(?:^|[\s"'])--settings(?:=|\s+|$)(?!["']?\{)/;

export interface LaunchDeps {
  configDir?: string; readFile?: (file: string) => string; processTable?: () => Promise<ProcessTable | null>; ppid?: number;
}

export function settingsVerdict(files: string[], readFile: (file: string) => string): LaunchVerdict {
  for (const file of files) {
    let text: string;
    try {
      text = readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return "unknown";
    }
    let mode: unknown;
    try {
      mode = (JSON.parse(text) as { permissions?: { defaultMode?: unknown } } | null)?.permissions?.defaultMode;
    } catch {
      return "unknown";
    }
    if (mode === "bypassPermissions") return "bypass";
  }
  return "ok";
}

export function ancestryVerdict(ppid: number, table: ProcessTable): LaunchVerdict {
  let pid = ppid;
  for (let depth = 0; depth < MAX_ANCESTORS && pid > 1; depth++) {
    const entry = table.get(pid);
    if (!entry) return depth === 0 ? "unknown" : "ok";
    if (entry.args === null) return "unknown";
    if (BYPASS_FLAG.test(entry.args)) return "bypass";
    if (SETTINGS_FILE.test(entry.args)) return "unknown";
    pid = entry.ppid;
  }
  return "ok";
}

export function parseWindowsTable(json: string): ProcessTable {
  const rows = JSON.parse(json) as unknown;
  const list = (Array.isArray(rows) ? rows : [rows]) as { ProcessId?: unknown; ParentProcessId?: unknown; CommandLine?: unknown }[];
  return new Map(list.filter((r) => Number.isInteger(r?.ProcessId) && Number.isInteger(r?.ParentProcessId))
    .map((r) => [r.ProcessId as number, { ppid: r.ParentProcessId as number, args: typeof r.CommandLine === "string" ? r.CommandLine : null }]));
}

export function parsePsTable(text: string): ProcessTable {
  const table: ProcessTable = new Map();
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)(?:\s(.*))?$/.exec(line.replace(/\r$/, ""));
    if (match) table.set(Number(match[1]), { ppid: Number(match[2]), args: match[3] ?? "" });
  }
  return table;
}

const runFile: RunFile = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: LIST_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
    (error, stdout) => (error ? reject(error) : resolve(stdout)));
});

// One listing of all processes; null when it cannot be taken or parsed.
export async function readProcessTable(platform: NodeJS.Platform = process.platform, run: RunFile = runFile): Promise<ProcessTable | null> {
  try {
    const table = platform === "win32"
      ? parseWindowsTable(await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"]))
      : parsePsTable(await run("ps", ["-A", "-ww", "-o", "pid=", "-o", "ppid=", "-o", "args="]));
    return table.size > 0 ? table : null;
  } catch {
    return null;
  }
}

export const defaultConfigDir = (): string => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");

export async function launchMode(cwd: unknown, deps: LaunchDeps = {}): Promise<LaunchVerdict> {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return "unknown";
  const files = [path.join(deps.configDir ?? defaultConfigDir(), "settings.json"),
    path.join(cwd, ".claude", "settings.json"), path.join(cwd, ".claude", "settings.local.json")];
  const settings = settingsVerdict(files, deps.readFile ?? ((file) => fs.readFileSync(file, "utf8")));
  if (settings !== "ok") return settings;
  const table = await (deps.processTable ?? (() => readProcessTable()))();
  return table ? ancestryVerdict(deps.ppid ?? process.ppid, table) : "unknown";
}

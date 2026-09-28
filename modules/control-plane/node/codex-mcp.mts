import { spawn } from "node:child_process";

import { codexCommand, findCodex } from "./codex-binary.mts";
import { lastLine } from "./codex-output.mts";
import { signalGroup, type CodexDeps } from "./codex-process.mts";

// Issue #119: a Codex intercom run the daemon starts keeps the user's Codex
// config (its hooks and guards) but runs with every MCP server that config
// defines switched off, one `-c mcp_servers.<name>.enabled=false` each.
// Measured with Codex CLI 0.157.1:
// - `codex mcp list --json` lists name and enabled of every server, including
//   those the desktop app or a plugin provides (cua_repl).
// - The key is split on dots as is: quotes stay part of the name
//   (`mcp_servers."rovo"` names a server `"rovo"`), so only bare names fit.
// - The override for a server the config does not define (an app or plugin
//   server, or no server at all) makes codex fail at startup with
//   `invalid transport` `in \`mcp_servers.<name>\``. The overrides are therefore
//   checked once with `codex <overrides> mcp list --json`; each name codex
//   rejects is dropped and the check repeated.
// Names come only from codex's own listing, never from peer messages. When
// the listing cannot be determined the run starts as before, without
// overrides; the reason goes to the daemon log.

export const MCP_LIST_TIMEOUT_MS = 30_000;
export const MCP_CACHE_MS = 5 * 60_000;
// A bare TOML key: nothing that could quote, escape or add a segment.
const BARE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const REJECTED = /in `mcp_servers\.([A-Za-z0-9_-]{1,64})`/;

export interface McpListResult { code: number | null; stdout: string; stderr: string }
export type McpList = (args: string[]) => Promise<McpListResult>;
export type McpOverrides = { args: string[]; names: string[]; unnamed: number } | { reason: string };

export const mcpOffArgs = (names: string[]): string[] => names.flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`]);

// The names of the enabled servers in a `codex mcp list --json` output; those
// that are not a bare key are counted apart. Throws on anything but a list.
export function enabledServers(stdout: string): { names: string[]; unnamed: number } {
  const rows = JSON.parse(stdout) as unknown;
  if (!Array.isArray(rows)) throw new Error("codex mcp list did not print a list");
  const names: string[] = [];
  let unnamed = 0;
  for (const row of rows as { name?: unknown; enabled?: unknown }[]) {
    if (row?.enabled !== true) continue;
    if (typeof row.name === "string" && BARE_NAME.test(row.name)) names.push(row.name);
    else unnamed += 1;
  }
  return { names: [...new Set(names)], unnamed };
}

// Lists, then checks the overrides as described above: at most one retry per name.
export async function computeOverrides(list: McpList): Promise<McpOverrides> {
  const first = await list(["mcp", "list", "--json"]);
  if (first.code !== 0) return { reason: `codex mcp list failed: ${lastLine(first.stderr) || `exit ${String(first.code)}`}` };
  let found: { names: string[]; unnamed: number };
  try {
    found = enabledServers(first.stdout);
  } catch {
    return { reason: "codex mcp list printed no server list" };
  }
  let names = found.names;
  for (let attempt = 0; attempt <= found.names.length; attempt += 1) {
    if (names.length === 0) return { args: [], names, unnamed: found.unnamed };
    const args = mcpOffArgs(names);
    const checked = await list([...args, "mcp", "list", "--json"]);
    if (checked.code === 0) {
      try {
        const still = enabledServers(checked.stdout).names.filter((name) => names.includes(name));
        if (still.length > 0) return { reason: `the override did not disable ${still.join(", ")}` };
      } catch {
        return { reason: "codex mcp list printed no server list" };
      }
      return { args, names, unnamed: found.unnamed };
    }
    const rejected = REJECTED.exec(checked.stderr)?.[1];
    if (!rejected || !names.includes(rejected)) {
      return { reason: `codex refused the overrides: ${lastLine(checked.stderr) || `exit ${String(checked.code)}`}` };
    }
    names = names.filter((name) => name !== rejected);
  }
  return { reason: "codex kept refusing the overrides" };
}

// Runs codex (through the npm launcher on Windows) without a shell and
// windowless, killing its process tree after the timeout.
export function runMcpList(file: string, codex: CodexDeps): McpList {
  const platform = codex.platform ?? process.platform;
  const timeoutMs = codex.mcpListTimeoutMs ?? MCP_LIST_TIMEOUT_MS;
  return (args) => new Promise((resolve) => {
    const command = codexCommand(file, args, platform);
    const child = spawn(command.file, command.args, { stdio: ["ignore", "pipe", "pipe"], detached: platform !== "win32", windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (result: McpListResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (child.pid !== undefined) (codex.signal ?? ((pid, signal) => signalGroup(pid, signal, platform)))(child.pid, "SIGKILL");
      settle({ code: null, stdout: "", stderr: `codex mcp list did not finish within ${Math.round(timeoutMs / 1000)} s` });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString("utf8")).slice(-1_048_576); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4096); });
    child.once("error", (error) => settle({ code: null, stdout: "", stderr: error.message }));
    child.once("close", (code) => settle({ code, stdout, stderr }));
  });
}

// One result per codex binary for MCP_CACHE_MS, shared by concurrent callers.
let cache: { file: string; at: number; result: Promise<McpOverrides> } | null = null;
export const resetMcpCache = (): void => { cache = null; };

export async function intercomMcpOverrides(codex: CodexDeps, now: number = Date.now()): Promise<McpOverrides> {
  const file = (codex.findCodex ?? findCodex)();
  if (!file) return { reason: "codex is not installed on this node" };
  if (cache && cache.file === file && now - cache.at < MCP_CACHE_MS) return cache.result;
  const list = codex.mcpList ?? runMcpList(file, codex);
  const result = computeOverrides(list).catch((error: unknown) => ({ reason: String((error as Error).message ?? error) }));
  cache = { file, at: now, result };
  return result;
}

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { codexCommand } from "./codex-binary.mts";
import type { Check } from "./doctor-local.mts";

// The checks of `kherep-node doctor` that look beyond the config directory
// (issue #215): the Worker's /health, the runtimes on this host and the hook
// commands the installers wrote. All reads; nothing is changed.

const pick = (value: unknown, type: "string" | "boolean"): unknown => (typeof value === type ? value : null);

// Only the known /health fields are copied; the body itself is never printed.
export async function checkWorker(controlUrl: string, fetcher: typeof fetch, timeoutMs = 5_000): Promise<Check> {
  let response: Response;
  try {
    response = await fetcher(new URL("/health", controlUrl), { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { ok: false, reachable: false, detail: "the Worker did not answer /health" };
  }
  let body: Record<string, unknown> = {};
  try { body = (await response.json()) as Record<string, unknown>; } catch { /* not JSON */ }
  const ok = response.status === 200 && body?.ok === true;
  return { ok, reachable: true, status: response.status, version: pick(body?.version, "string"),
    commit: pick(body?.commit, "string"), remoteMcp: pick(body?.remoteMcp, "boolean"),
    ...(ok ? {} : { detail: "/health did not report ok" }) };
}

export type VersionOf = (name: string, file: string) => Promise<string | null>;

const run = promisify(execFile);

// The first line of `<runtime> --version`. A Windows .cmd shim other than
// codex's npm launcher is not run, since that would need cmd.exe.
export const runtimeVersion: VersionOf = async (name, file) => {
  let command: { file: string; args: string[] };
  try {
    command = name === "codex" ? codexCommand(file, ["--version"]) : { file, args: ["--version"] };
  } catch {
    return null;
  }
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command.file)) return null;
  try {
    const { stdout } = await run(command.file, command.args, { timeout: 10_000, windowsHide: true });
    return stdout.trim().split(/\r?\n/)[0].slice(0, 120) || null;
  } catch {
    return null;
  }
};

// configured: the runtimes the sessions policy names. Readiness needs the
// runtime readiness probe, which this node does not have yet.
export async function checkRuntimes(configured: string[], find: (name: string) => string | null,
  versionOf: VersionOf): Promise<Check> {
  const runtimes: Record<string, unknown> = {};
  let failed = false;
  let installed = 0;
  for (const name of ["claude", "codex"]) {
    const file = find(name);
    const version = file ? await versionOf(name, file) : null;
    const isConfigured = configured.includes(name);
    if (file) installed++;
    if (isConfigured && (!file || !version)) failed = true;
    runtimes[name] = { installed: file !== null, version, configured: isConfigured, ready: "not available" };
  }
  let detail: string | undefined;
  if (installed === 0) detail = "neither claude nor codex is installed";
  else if (failed) detail = "a runtime the sessions policy names is missing or does not report a version";
  return { ok: installed > 0 && !failed, ...runtimes, ...(detail ? { detail } : {}) };
}

// Hook commands name the script by path and a quote ends it. Claude settings
// are parsed, since JSON may also escape "/"; a TOML basic string escapes a
// backslash as two.
const HOOK_PATH = /[^"'\n]*?modules[\\/]+control-plane[\\/]+node[\\/]+(deliver|wake)-hook\.mts/g;

function realOrResolved(file: string): string {
  try { return fs.realpathSync.native(file); } catch { return path.resolve(file); }
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(strings);
}

type HookScan = { present: boolean; deliver: number; wake: number; foreign: string[] };

function scanHooks(file: string, repoRoot: string): HookScan | null {
  let texts: string[];
  try {
    const text = fs.readFileSync(file, "utf8");
    texts = file.endsWith(".json") ? strings(JSON.parse(text)) : [text.replace(/\\\\/g, "\\")];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { present: false, deliver: 0, wake: 0, foreign: [] };
    return null;
  }
  const counts = { deliver: 0, wake: 0 };
  const foreign = new Set<string>();
  for (const match of texts.flatMap((text) => [...text.matchAll(HOOK_PATH)])) {
    const kind = match[1] as "deliver" | "wake";
    const expected = path.join(repoRoot, "modules", "control-plane", "node", `${kind}-hook.mts`);
    if (realOrResolved(match[0]) === realOrResolved(expected)) counts[kind]++;
    else foreign.add(match[0]);
  }
  return { present: true, ...counts, foreign: [...foreign] };
}

// ok: at least one hook is installed and every hook command names this checkout.
export function checkHooks(files: { claude: string; codex: string }, repoRoot: string): Check {
  const claude = scanHooks(files.claude, repoRoot);
  const codex = scanHooks(files.codex, repoRoot);
  if (!claude || !codex) return { ok: false, detail: "a runtime configuration file is unreadable" };
  const foreign = claude.foreign.length + codex.foreign.length;
  const total = claude.deliver + claude.wake + codex.deliver + codex.wake + foreign;
  let detail: string | undefined;
  if (foreign > 0) detail = "a hook command names another checkout";
  else if (total === 0) detail = "no delivery or wake hook is installed";
  return { ok: foreign === 0 && total > 0, checkout: repoRoot, claude, codex, ...(detail ? { detail } : {}) };
}

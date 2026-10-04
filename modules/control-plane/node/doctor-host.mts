import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { codexCommand, findCodex } from "./codex-binary.mts";
import type { Check } from "./doctor-local.mts";
import { aged } from "./runtime-readiness.mts";
import { claudeCall, findClaude, type Invocation } from "./sessions.mts";

// The checks of `kherep-node doctor` that look beyond the config directory
// (issue #215): the Worker's /health and the runtimes on this host. Nothing
// is changed.

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

// Where the node itself starts each runtime: claude.exe beside an npm
// claude.cmd shim (findClaude), codex as found on PATH.
export const findRuntime = (name: string): string | null => (name === "claude" ? findClaude() : findCodex());

const VERSION_TIMEOUT_MS = 10_000;

// `<runtime> --version` as the node launches that runtime: a remaining claude
// .cmd shim through cmd.exe with fixed arguments (claudeCall), codex's npm
// shim through its launcher with this Node (codexCommand). Null: not runnable.
export function versionInvocation(name: string, file: string, platform: NodeJS.Platform = process.platform,
  exists?: (file: string) => boolean, comSpec?: string): Invocation | null {
  try {
    if (name === "claude") return claudeCall(file, ["--version"], VERSION_TIMEOUT_MS, platform, comSpec);
    const command = codexCommand(file, ["--version"], platform, exists);
    return { ...command, options: { timeout: VERSION_TIMEOUT_MS } };
  } catch {
    return null;
  }
}

const run = promisify(execFile);

// The first line of the runtime's version output.
export const runtimeVersion: VersionOf = async (name, file) => {
  const call = versionInvocation(name, file);
  if (!call) return null;
  try {
    const { stdout } = await run(call.file, call.args, { ...call.options, windowsHide: true, encoding: "utf8" });
    return stdout.trim().split(/\r?\n/)[0].slice(0, 120) || null;
  } catch {
    return null;
  }
};

const CAUSES: readonly unknown[] = ["sign-in", "timeout", "error"];

// The running daemon's last probe of one runtime (issue #222); doctor never
// probes. "unknown" without a valid record. aged: past the daemon's own TTL,
// which keeps acting on and advertising the verdict until its next probe.
function readinessOf(record: unknown, now: number): Record<string, unknown> {
  const { ready, cause, probedAt } = (record ?? {}) as Record<string, unknown>;
  const at = typeof probedAt === "string" ? Date.parse(probedAt) : Number.NaN;
  if (typeof ready !== "boolean" || Number.isNaN(at) || (!ready && !CAUSES.includes(cause))) return { ready: "unknown" };
  return { ready, ...(ready ? {} : { cause }), probedAt, aged: aged({ ready, at }, now) };
}

// configured: the runtimes the sessions policy names. readiness: daemon.json's
// record of a running daemon, else null. Only a sign-in failure fails the
// check, as only it makes the node refuse a run (runtime-readiness.mts).
export async function checkRuntimes(configured: string[], find: (name: string) => string | null,
  versionOf: VersionOf, readiness: Record<string, unknown> | null, now: number): Promise<Check> {
  const runtimes: Record<string, unknown> = {};
  let failed = false;
  let signedOut = false;
  let installed = 0;
  for (const name of ["claude", "codex"]) {
    const file = find(name);
    const version = file ? await versionOf(name, file) : null;
    const isConfigured = configured.includes(name);
    const probe = readinessOf(readiness?.[name], now);
    if (file) installed++;
    if (isConfigured && (!file || !version)) failed = true;
    if (isConfigured && probe.cause === "sign-in") signedOut = true;
    runtimes[name] = { installed: file !== null, version, configured: isConfigured, ...probe };
  }
  let detail: string | undefined;
  if (installed === 0) detail = "neither claude nor codex is installed";
  else if (failed) detail = "a runtime the sessions policy names is missing or does not report a version";
  else if (signedOut) detail = "a runtime the sessions policy names is not signed in";
  return { ok: !detail, ...runtimes, ...(detail ? { detail } : {}) };
}

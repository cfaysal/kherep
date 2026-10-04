import { spawn } from "node:child_process";
import os from "node:os";

import type { TaskRuntime } from "../protocol-tasks.mts";
import { codexCommand, findCodex } from "./codex-binary.mts";
import { intercomMcpOverrides } from "./codex-mcp.mts";
import { lastLine } from "./codex-output.mts";
import { signalGroup } from "./codex-process.mts";
import { claudeCall, findClaude } from "./sessions.mts";

// Issue #197: can a runtime run a turn at all? `claude auth status` reported
// loggedIn true for an expired login (live finding 2026-10-04), so the probe is
// the smallest real call that has to authenticate, never a local status read.
// - Claude Code (https://code.claude.com/docs/en/cli-reference, /headless,
//   /errors, fetched 2026-10-04): `-p` with `--output-format json` prints one
//   result object with `is_error`. `--safe-mode` loads no CLAUDE.md, hooks,
//   plugins or MCP servers (so no Kherep hook sees the probe), `--tools ""` and
//   a one-line `--system-prompt` keep the request minimal, and
//   `--no-session-persistence` leaves no session behind. An expired login
//   "stops locally ... before it reaches the API" with `Failed to authenticate:
//   OAuth session expired`, at no cost.
// - Codex (`codex exec --help`, CLI 0.160.0): the user's config.toml as a real
//   run loads it (model, provider, auth), without hooks (CODEX_PROBE_CONFIG)
//   and with its MCP servers disabled by the overrides intercom runs use
//   (codex-mcp.mts); `--ephemeral` persists no session files; read-only
//   sandbox, prompt on stdin, ready only after `turn.completed`. Should a
//   delivery hook still record the probe's thread as a Codex session,
//   forgetSession removes that record afterwards, also after a timeout.
// Claude's account default model answers. The probe prints nothing a CLI wrote
// except a redacted last line (codex-output.mts lastLine).

export const PROBE_TIMEOUT_MS = 45_000;
const PROMPT = "Reply with OK.";
export const CLAUDE_PROBE_ARGS: readonly string[] = ["-p", "--safe-mode", "--no-session-persistence", "--strict-mcp-config",
  "--tools", "", "--output-format", "json", "--system-prompt", PROMPT, "OK"];
// No hooks for the probe: an installed node's Stop, SessionStart and
// UserPromptSubmit hooks would dispatch observation work, write memory and
// outlast the timeout. `codex features list` (CLI 0.160.0, measured 2026-10-04)
// shows `hooks stable true`, and `-c features.hooks=false` turns it false;
// `features.codex_hooks` is accepted there without effect and kept for older CLIs.
export const CODEX_PROBE_CONFIG: readonly string[] = ["-c", "features.hooks=false", "-c", "features.codex_hooks=false"];
export const codexProbeArgs = (cwd: string, overrides: string[] = []): string[] =>
  [...CODEX_PROBE_CONFIG, ...overrides, "exec", "--json", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "-C", cwd, "-"];

export type ProbeCause = "sign-in" | "timeout" | "error";
export type ProbeResult = { ok: true } | { ok: false; cause: ProbeCause; detail: string };
export interface ProbeRun { code: number | null; stdout: string; stderr: string; timedOut: boolean }
export interface ProbeSpawnOptions { cwd: string; timeoutMs: number; input?: string; verbatim?: boolean }
export type ProbeSpawn = (file: string, args: string[], options: ProbeSpawnOptions) => Promise<ProbeRun>;
export interface ProbeDeps {
  findClaude?: () => string | null; findCodex?: () => string | null; platform?: NodeJS.Platform; comSpec?: string;
  run?: ProbeSpawn; timeoutMs?: number; cwd?: string;
  // Codex: the `-c mcp_servers.<name>.enabled=false` overrides (intercomMcpOverrides by default).
  mcpOverrides?: () => Promise<string[]>;
  // Codex: removes the session record a delivery hook wrote for the probe's thread.
  forgetSession?: (threadId: string) => void;
}

async function codexOverrides(deps: ProbeDeps): Promise<string[]> {
  if (deps.mcpOverrides) return deps.mcpOverrides();
  const found = await intercomMcpOverrides({ ...(deps.findCodex ? { findCodex: deps.findCodex } : {}),
    ...(deps.platform ? { platform: deps.platform } : {}) });
  return "args" in found ? found.args : [];
}

// The documented sign-in failures: "Not logged in · Please run /login", "Login
// expired", "OAuth token has expired", "API Error: 401", "Failed to authenticate".
const SIGN_IN = /\b401\b|unauthori[sz]ed|not (?:logged|signed) in|log ?in\b|sign ?in\b|expired|authenticat|api key|credential/i;

export function failure(text: string): ProbeResult {
  return { ok: false, cause: SIGN_IN.test(text) ? "sign-in" : "error", detail: lastLine(text) };
}

const MAX_OUTPUT = 65_536;

// Without a shell, in its own process group on POSIX (codex runs behind its npm
// launcher), killed with its tree at the timeout.
export const spawnProbe = (platform: NodeJS.Platform = process.platform): ProbeSpawn => (file, args, options) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(file, args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], detached: platform !== "win32",
      windowsHide: true, windowsVerbatimArguments: options.verbatim === true });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) signalGroup(child.pid, "SIGKILL", platform);
    }, options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout = (stdout + chunk).slice(-MAX_OUTPUT); });
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-MAX_OUTPUT); });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
    const settle = (code: number | null): void => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    child.once("error", (error) => {
      stderr += String(error.message);
      settle(null);
    });
    child.once("close", (code) => settle(code));
  });

function lastJson(text: string): Record<string, unknown> | null {
  for (const line of text.trim().split(/\r?\n/).reverse()) {
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // not the result line
    }
  }
  return null;
}

async function probeClaude(deps: ProbeDeps, run: ProbeSpawn, timeoutMs: number, cwd: string): Promise<ProbeResult> {
  const claude = (deps.findClaude ?? findClaude)();
  if (!claude) return { ok: false, cause: "error", detail: "claude is not installed on this node" };
  let call: ReturnType<typeof claudeCall>;
  try {
    call = claudeCall(claude, [...CLAUDE_PROBE_ARGS], timeoutMs, deps.platform, deps.comSpec);
  } catch (error) {
    return { ok: false, cause: "error", detail: String((error as Error).message) };
  }
  const out = await run(call.file, call.args, { cwd, timeoutMs, verbatim: call.options.windowsVerbatimArguments });
  if (out.timedOut) return { ok: false, cause: "timeout", detail: "" };
  const result = lastJson(out.stdout);
  if (out.code === 0 && result?.type === "result" && result.is_error === false) return { ok: true };
  return failure([typeof result?.result === "string" ? result.result : "", out.stderr].join("\n").trim() || out.stdout);
}

async function probeCodex(deps: ProbeDeps, run: ProbeSpawn, timeoutMs: number, cwd: string): Promise<ProbeResult> {
  const codex = (deps.findCodex ?? findCodex)();
  if (!codex) return { ok: false, cause: "error", detail: "codex is not installed on this node" };
  let command: ReturnType<typeof codexCommand>;
  try {
    command = codexCommand(codex, codexProbeArgs(cwd, await codexOverrides(deps)), deps.platform);
  } catch (error) {
    return { ok: false, cause: "error", detail: String((error as Error).message) };
  }
  const out = await run(command.file, command.args, { cwd, timeoutMs, input: PROMPT });
  const events = out.stdout.split(/\r?\n/).flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line);
      return typeof value === "object" && value !== null ? [value as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
  // Also after a timeout or an error: a session record left behind would be listed for 12 hours.
  const thread = events.find((e) => e.type === "thread.started")?.thread_id;
  if (typeof thread === "string") deps.forgetSession?.(thread);
  if (out.timedOut) return { ok: false, cause: "timeout", detail: "" };
  if (out.code === 0 && events.some((e) => e.type === "turn.completed")) return { ok: true };
  const error = events.flatMap((e) => {
    if (e.type === "error" && typeof e.message === "string") return [e.message];
    const message = (e.error as { message?: unknown } | undefined)?.message;
    return e.type === "turn.failed" && typeof message === "string" ? [message] : [];
  }).at(-1);
  return failure([error ?? "", out.stderr].join("\n").trim() || `codex exited with ${String(out.code)}`);
}

export function probeRuntime(runtime: TaskRuntime, deps: ProbeDeps = {}): Promise<ProbeResult> {
  const run = deps.run ?? spawnProbe(deps.platform);
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  const cwd = deps.cwd ?? os.tmpdir();
  return runtime === "codex" ? probeCodex(deps, run, timeoutMs, cwd) : probeClaude(deps, run, timeoutMs, cwd);
}

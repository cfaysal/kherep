import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { isSessionInfo, type SessionInfo } from "../protocol.mts";
import { listCodexSessions, listCodexTaskSessions } from "./codex-sessions.mts";
import type { NodePaths } from "./config.mts";
import { findOnPath } from "./discovery.mts";
import { listTasks, type TaskRecord } from "./task-records.mts";

// Agent session discovery (issue #31, step 2). Claude Code lists its running
// sessions with `claude agents --json` (https://code.claude.com/docs/en/sessions).
// Codex sessions come from the records the delivery hook writes and from the
// Codex tasks this node started (codex-sessions.mts).

export const CLAUDE_RUNTIME = "claude-code";
export const LIST_TIMEOUT_MS = 10_000;
const MAX_SESSIONS = 512;

export interface ExecOptions { timeout: number; windowsVerbatimArguments?: boolean; cwd?: string }
// Runs an executable and resolves with its stdout.
export type Exec = (file: string, args: string[], options: ExecOptions) => Promise<string>;

export interface SessionDeps {
  findClaude?: () => string | null;
  exec?: Exec;
  platform?: NodeJS.Platform;
  comSpec?: string;
  // With paths, the Codex sessions recorded in this node's config directory are listed too.
  paths?: NodePaths;
  now?: () => number;
}

export interface Invocation { file: string; args: string[]; options: ExecOptions }

const execFileText: Exec = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, { ...options, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout);
  });
});

// How `claude agents --json` is started. An executable runs directly, without
// a shell. An npm install on Windows provides only a claude.cmd shim, which
// execFile cannot start without the command interpreter; it then runs
// through cmd.exe with a fixed command line. The path comes from findOnPath,
// never from a message, and one that cmd.exe would expand is refused.
export function claudeInvocation(resolved: string, platform: NodeJS.Platform = process.platform,
  comSpec: string = process.env.ComSpec || "cmd.exe"): Invocation {
  return claudeCall(resolved, ["agents", "--json"], LIST_TIMEOUT_MS, platform, comSpec);
}

// Arguments cmd.exe passes through unchanged: no spaces, quotes, % or
// metacharacters. cmd.exe cannot carry arbitrary text safely, so a prompt
// never qualifies and a session start through a .cmd shim is refused.
const CMD_SAFE_ARG = /^[A-Za-z0-9._:\\/=-]+$/;

// The same rule for any claude command line (session control, item 5).
export function claudeCall(resolved: string, args: string[], timeout: number, platform: NodeJS.Platform = process.platform,
  comSpec: string = process.env.ComSpec || "cmd.exe"): Invocation {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(resolved)) {
    if (/["%]/.test(resolved)) throw new Error("claude path is not safe for cmd.exe");
    if (!args.every((arg) => CMD_SAFE_ARG.test(arg))) {
      throw new Error("claude is a .cmd shim, and cmd.exe cannot pass this text safely; install the native claude executable");
    }
    return { file: comSpec, args: ["/d", "/s", "/c", `"${resolved}" ${args.join(" ")}`], options: { timeout, windowsVerbatimArguments: true } };
  }
  return { file: resolved, args, options: { timeout } };
}

// An npm install on Windows puts a claude.cmd shim on PATH that only starts the
// native executable shipped in the package. When that executable sits next to
// the shim it runs directly, so a task prompt never passes through cmd.exe.
const NPM_NATIVE = ["node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"];
export function nativeClaude(resolved: string, exists: (file: string) => boolean = (file) => fs.existsSync(file)): string {
  if (!/[\\/]claude\.cmd$/i.test(resolved)) return resolved;
  const native = path.win32.join(path.win32.dirname(resolved), ...NPM_NATIVE);
  return exists(native) ? native : resolved;
}

export function findClaude(): string | null {
  const found = findOnPath("claude");
  return found && nativeClaude(found);
}

function optional(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

// Maps the rows of `claude agents --json`. Unknown fields are ignored and a
// malformed row is skipped; only output that is not a JSON array fails.
export function mapClaudeAgents(value: unknown): SessionInfo[] | null {
  if (!Array.isArray(value)) return null;
  const sessions: SessionInfo[] = [];
  for (const row of value) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    const started = typeof r.startedAt === "number" && Number.isFinite(r.startedAt) ? new Date(r.startedAt) : null;
    const session: SessionInfo = {
      sessionId: r.sessionId as string, runtime: CLAUDE_RUNTIME, state: r.status as string,
      startedAt: started && !Number.isNaN(started.getTime()) ? started.toISOString() : undefined,
      name: optional(r.name, 128), cwd: optional(r.cwd, 512), kind: optional(r.kind, 32),
    };
    for (const key of Object.keys(session) as (keyof SessionInfo)[]) if (session[key] === undefined) delete session[key];
    if (isSessionInfo(session) && sessions.length < MAX_SESSIONS) sessions.push(session);
  }
  return sessions;
}

// Resolves with the sessions of every runtime found on PATH plus the recorded
// Codex sessions, and rejects when a listing fails: a failed read must not
// look like an empty node. Without claude on PATH it contributes nothing.
export async function listSessions(deps: SessionDeps = {}): Promise<SessionInfo[]> {
  const now = deps.now?.() ?? Date.now();
  const tasks = deps.paths ? listCodexTaskSessions(deps.paths, now) : [];
  // A task's thread the delivery hook recorded too is listed once, as the task.
  const codex = deps.paths ? listCodexSessions(deps.paths, now).filter((s) => !tasks.some((t) => t.sessionId === s.sessionId)) : [];
  const claude = await listClaudeSessions(deps);
  return [...(deps.paths ? withLabels(claude, listTasks(deps.paths)) : claude), ...tasks, ...codex].slice(0, MAX_SESSIONS);
}

// A Claude task session with a label (issue #74) carries it, found by the
// session id or the task-<8> name the node started it with.
export function withLabels(sessions: SessionInfo[], tasks: TaskRecord[]): SessionInfo[] {
  return sessions.map((s) => {
    const task = tasks.find((t) => t.label && (t.sessionId === s.sessionId || t.name === s.name));
    return task ? { ...s, label: task.label } : s;
  });
}

async function listClaudeSessions(deps: SessionDeps): Promise<SessionInfo[]> {
  const claude = (deps.findClaude ?? findClaude)();
  if (!claude) return [];
  const run = claudeInvocation(claude, deps.platform, deps.comSpec);
  const output = await (deps.exec ?? execFileText)(run.file, run.args, run.options)
    .catch((error: unknown) => { throw new Error(`claude agents failed: ${String((error as Error).message ?? error).slice(0, 200)}`); });
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("claude agents printed no JSON");
  }
  const sessions = mapClaudeAgents(parsed);
  if (!sessions) throw new Error("claude agents printed no session list");
  return sessions;
}

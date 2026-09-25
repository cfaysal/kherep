import { execFile } from "node:child_process";

import { isSessionInfo, type SessionInfo } from "../protocol.mts";
import { findOnPath } from "./discovery.mts";

// Agent session discovery (issue #31, step 2). Claude Code lists its running
// sessions with `claude agents --json` (https://code.claude.com/docs/en/sessions).
// Codex sessions are not reported yet.

export const CLAUDE_RUNTIME = "claude-code";
export const LIST_TIMEOUT_MS = 10_000;
const MAX_SESSIONS = 512;

export interface ExecOptions { timeout: number; windowsVerbatimArguments?: boolean }
// Runs an executable and resolves with its stdout.
export type Exec = (file: string, args: string[], options: ExecOptions) => Promise<string>;

export interface SessionDeps {
  findClaude?: () => string | null;
  exec?: Exec;
  platform?: NodeJS.Platform;
  comSpec?: string;
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
  if (platform === "win32" && /\.(cmd|bat)$/i.test(resolved)) {
    if (/["%]/.test(resolved)) throw new Error("claude path is not safe for cmd.exe");
    return { file: comSpec, args: ["/d", "/s", "/c", `"${resolved}" agents --json`],
      options: { timeout: LIST_TIMEOUT_MS, windowsVerbatimArguments: true } };
  }
  return { file: resolved, args: ["agents", "--json"], options: { timeout: LIST_TIMEOUT_MS } };
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

// Resolves with the sessions of every runtime found on PATH, and rejects when
// a runtime is present but its listing fails: a failed read must not look
// like an empty node. Without claude on PATH it contributes nothing.
export async function listSessions(deps: SessionDeps = {}): Promise<SessionInfo[]> {
  const claude = (deps.findClaude ?? (() => findOnPath("claude")))();
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

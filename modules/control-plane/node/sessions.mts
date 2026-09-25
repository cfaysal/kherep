import { execFile } from "node:child_process";

import { isSessionInfo, type SessionInfo } from "../protocol.mts";
import { findOnPath } from "./discovery.mts";

// Agent session discovery (issue #31, step 2). Claude Code lists its running
// sessions with `claude agents --json` (https://code.claude.com/docs/en/sessions).
// Codex sessions are not reported yet.

export const CLAUDE_RUNTIME = "claude-code";
export const LIST_TIMEOUT_MS = 10_000;
const MAX_SESSIONS = 512;

// Runs an executable without a shell and resolves with its stdout.
export type Exec = (file: string, args: string[], timeoutMs: number) => Promise<string>;

export interface SessionDeps {
  findClaude?: () => string | null;
  exec?: Exec;
}

const execNoShell: Exec = (file, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout);
  });
});

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
  const output = await (deps.exec ?? execNoShell)(claude, ["agents", "--json"], LIST_TIMEOUT_MS)
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

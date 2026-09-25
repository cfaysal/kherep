import { execFile } from "node:child_process";

import {
  DELEGATED_PERMISSION_MODES, type SessionContinueArgs, type SessionStartArgs, type SessionStopArgs,
} from "../protocol-tasks.mts";
import type { NodePaths } from "./config.mts";
import { findOnPath } from "./discovery.mts";
import { cliCommand } from "./msg-cli.mts";
import type { NodePolicy } from "./policy.mts";
import { claudeCall, LIST_TIMEOUT_MS, type Exec } from "./sessions.mts";
import { isActive, listTasks, queueReport, readTask, writeTask, type TaskRecord } from "./task-records.mts";
import { frameFollowUp, framePrompt, resolveCwd } from "./task-prompt.mts";

// Starts, continues and stops Claude Code background sessions for tasks
// (issue #31, item 5), from https://code.claude.com/docs/en/agent-view and
// /docs/en/cli-reference (fetched 2026-09-25):
// - `claude --bg` / `--background` "Start the session as a background agent
//   and return immediately"; the prompt is the positional argument.
// - `--name` sets "the session's display name in agent view"; `--permission-mode`
//   accepts default, acceptEdits, plan, auto, dontAsk, bypassPermissions.
// - "After backgrounding, Claude prints the session's short ID ...":
//   `backgrounded · 7c5dcf5d · flaky-test-fix`, possibly after `Starting
//   background service…`.
// - `claude --resume <full session id> --bg "<prompt>"` continues a session,
//   in place or as a copy under a new id; `claude stop <id>` takes the short id.
// - `claude agents --json --all` lists sessions with `id` (short), `sessionId`,
//   `name` and `state` (working, blocked, done, failed, stopped).

export const RUN_TIMEOUT_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;
const BACKGROUNDED = /^backgrounded · ([A-Za-z0-9]+)/m;

export interface RunnerDeps {
  paths: NodePaths; policy: NodePolicy;
  exec?: Exec; findClaude?: () => string | null; platform?: NodeJS.Platform; comSpec?: string;
  now?: () => number; realpath?: (p: string) => string; cli?: string;
}

// Rejects with the CLI's own stderr (or stdout), never with the command line,
// which carries the task text.
const execClaude: Exec = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, { ...options, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (!error) return resolve(String(stdout));
    const code = (error as { code?: unknown }).code;
    reject(new Error(String(stderr).trim() || String(stdout).trim() || `claude exited with ${String(code)}`));
  });
});

const trim = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 256) || "no reason given";

export async function runClaude(deps: RunnerDeps, args: string[], cwd?: string): Promise<string> {
  const claude = (deps.findClaude ?? (() => findOnPath("claude")))();
  if (!claude) throw new Error("claude is not installed on this node");
  const run = claudeCall(claude, args, args[0] === "agents" ? LIST_TIMEOUT_MS : RUN_TIMEOUT_MS, deps.platform, deps.comSpec);
  return (deps.exec ?? execClaude)(run.file, run.args, { ...run.options, ...(cwd ? { cwd } : {}) });
}

// The rows of `claude agents --json --all`; rejects when the listing fails.
export async function agentRows(deps: RunnerDeps): Promise<Record<string, unknown>[]> {
  const parsed: unknown = JSON.parse(await runClaude(deps, ["agents", "--json", "--all"]));
  if (!Array.isArray(parsed)) throw new Error("claude agents printed no session list");
  return parsed.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null);
}

// The row of a task session: by the short id `--bg` printed, else by its name.
export function findRow(rows: Record<string, unknown>[], record: Pick<TaskRecord, "shortId" | "name">): Record<string, unknown> | undefined {
  return rows.find((r) => record.shortId !== undefined && r.id === record.shortId) ?? rows.find((r) => r.name === record.name);
}

export function mapIds(record: TaskRecord, row: Record<string, unknown> | undefined): TaskRecord {
  const sessionId = typeof row?.sessionId === "string" ? row.sessionId : record.sessionId;
  const shortId = typeof row?.id === "string" ? row.id : record.shortId;
  return { ...record, ...(sessionId ? { sessionId } : {}), ...(shortId ? { shortId } : {}) };
}

// Queues task.report failed and rejects, so the command result fails too.
function refuse(deps: RunnerDeps, taskId: string, reason: string): never {
  queueReport(deps.paths, { taskId, state: "failed", reason: trim(reason) });
  throw new Error(reason);
}

// Runs `claude ... --bg ...` and records the task with the short id it
// printed; the full session id follows from `claude agents --json --all`.
async function background(deps: RunnerDeps, record: TaskRecord, args: string[]): Promise<TaskRecord> {
  let output: string;
  try {
    output = await runClaude(deps, args, record.cwd);
  } catch (error) {
    const message = String((error as Error).message);
    writeTask(deps.paths, { ...record, state: "failed", reason: trim(message) });
    return refuse(deps, record.taskId, message);
  }
  const shortId = BACKGROUNDED.exec(output)?.[1];
  if (!shortId) {
    writeTask(deps.paths, { ...record, state: "failed", reason: "no session id printed" });
    return refuse(deps, record.taskId, `claude --bg printed no session id: ${trim(output)}`);
  }
  let mapped: TaskRecord = { ...record, shortId, state: "started" };
  try {
    mapped = mapIds(mapped, findRow(await agentRows(deps), mapped));
  } catch {
    // mapped later by the watch round
  }
  const saved = writeTask(deps.paths, mapped, deps.now?.());
  queueReport(deps.paths, { taskId: saved.taskId, state: "started", ...(saved.sessionId ? { sessionId: saved.sessionId } : {}) });
  return saved;
}

// The reason a start (or, with except, a continue) exceeds a limit, or null.
function overLimit(deps: RunnerDeps, now: number, except?: string): string | null {
  const policy = deps.policy.sessions!;
  const tasks = listTasks(deps.paths).filter((t) => t.taskId !== except);
  if (tasks.filter(isActive).length >= policy.maxConcurrent) return `this node runs at most ${policy.maxConcurrent} task sessions at a time`;
  if (except === undefined && tasks.filter((t) => now - Date.parse(t.startedAt) < DAY_MS).length >= policy.maxStartsPerDay) {
    return `this node starts at most ${policy.maxStartsPerDay} task sessions per day`;
  }
  return null;
}

export async function startTask(args: SessionStartArgs, deps: RunnerDeps): Promise<{ taskId: string; state: string; sessionId?: string }> {
  const existing = readTask(deps.paths, args.taskId);
  if (existing) return { taskId: existing.taskId, state: existing.state }; // a resent command
  const policy = deps.policy.sessions;
  if (!policy?.enabled) refuse(deps, args.taskId, "sessions are not enabled on this node");
  if (!policy.runtimes.includes(args.runtime)) refuse(deps, args.taskId, `runtime ${args.runtime} is not supported on this node yet`);
  const mode = args.permissionMode;
  if (!policy.permissionModes.includes(mode)) refuse(deps, args.taskId, `permission mode ${mode} is not allowed on this node`);
  if (args.requestedBy !== undefined) {
    if (!policy.delegate.accept) refuse(deps, args.taskId, "this node does not accept delegated tasks");
    if (!DELEGATED_PERMISSION_MODES.includes(mode)) refuse(deps, args.taskId, "a delegated task runs in permission mode auto or default");
  }
  const now = deps.now?.() ?? Date.now();
  const limit = overLimit(deps, now);
  if (limit) refuse(deps, args.taskId, limit);
  const cwd = resolveCwd(policy, args.cwd, deps.realpath);
  if (!cwd.ok) return refuse(deps, args.taskId, cwd.reason);
  const cli = deps.cli ?? cliCommand();
  const delegation = args.requestedBy !== undefined ? { requestedBy: args.requestedBy, directive: args.directive ?? "" } : undefined;
  const record: TaskRecord = {
    taskId: args.taskId, name: args.name, cwd: cwd.cwd, permissionMode: mode, state: "started", startedAt: new Date(now).toISOString(),
    deadline: new Date(now + policy.maxRuntimeMinutes * 60_000).toISOString(), updatedAt: new Date(now).toISOString(),
    ...(args.requestedBy !== undefined ? { requestedBy: args.requestedBy } : {}),
  };
  const saved = await background(deps, record,
    ["--bg", "--name", args.name, "--permission-mode", mode, framePrompt(args.taskId, args.prompt, cli, delegation)]);
  return { taskId: saved.taskId, state: saved.state, ...(saved.sessionId ? { sessionId: saved.sessionId } : {}) };
}

// Only a task this node started, whose session is known and not running.
export async function continueTask(args: SessionContinueArgs, deps: RunnerDeps): Promise<{ taskId: string; state: string }> {
  const record = readTask(deps.paths, args.taskId);
  if (!record) throw new Error("this node did not start that task");
  if (!deps.policy.sessions?.enabled) throw new Error("sessions are not enabled on this node");
  if (!record.sessionId) throw new Error("the task's session id is not known yet");
  if (record.state === "started" || record.state === "running") throw new Error("the task's session is still running");
  const now = deps.now?.() ?? Date.now();
  const limit = overLimit(deps, now, args.taskId);
  if (limit) throw new Error(limit);
  const restarted: TaskRecord = { ...record, state: "started", reason: undefined,
    deadline: new Date(now + deps.policy.sessions.maxRuntimeMinutes * 60_000).toISOString() };
  const saved = await background(deps, restarted, ["--resume", record.sessionId, "--bg", "--permission-mode", record.permissionMode,
    frameFollowUp(args.taskId, args.prompt, deps.cli ?? cliCommand())]);
  return { taskId: saved.taskId, state: saved.state };
}

// `claude stop <short id>` for a task this node started.
export async function stopTask(args: SessionStopArgs, deps: RunnerDeps, reason = "stopped by the operator"): Promise<{ taskId: string; state: string }> {
  const record = readTask(deps.paths, args.taskId);
  if (!record) throw new Error("this node did not start that task");
  if (!record.shortId) throw new Error("the task's session id is not known yet");
  await runClaude(deps, ["stop", record.shortId]);
  const saved = writeTask(deps.paths, { ...record, state: "stopped", reason }, deps.now?.());
  queueReport(deps.paths, { taskId: saved.taskId, state: "stopped", reason, ...(saved.sessionId ? { sessionId: saved.sessionId } : {}) });
  return { taskId: saved.taskId, state: saved.state };
}

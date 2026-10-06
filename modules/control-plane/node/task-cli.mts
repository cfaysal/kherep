import { parseArgs } from "node:util";
import { isNodeId } from "../protocol.mts";

import {
  isTaskId, isTaskRequirements, isTaskText, isTaskTitle, MAX_DIRECTIVE, MAX_SUMMARY, SUPPORTED_RUNTIMES, type TaskRequirements,
  type TaskRuntime,
} from "../protocol-tasks.mts";
import { readConfig, type NodePaths } from "./config.mts";
import { CODEX_ACTIVE_MS, readCodexSession } from "./codex-sessions.mts";
import { KHEREP_SESSION_ENV, senderSession, senderSessionId, SESSION_ENV, sessionIdFromEnv } from "./msg-resolve.mts";
import { loadPolicy } from "./policy.mts";
import { listTaskLines, resolveTaskDetail } from "./task-detail.mts";
import { NO_CHAINS, NOT_DELEGATING, TASKS_ACTIVE } from "./task-exchange.mts";
import {
  hasActiveTask, isActive, queueReport, readTask, taskForSession, writeRequest, writeTask,
} from "./task-records.mts";

// kherep-node task: the session side of tasks (issue #31, item 5). Like the msg
// CLI it only reads and writes files in the node's config directory; the
// daemon sends them.
//   task done  a session started for a task reports it finished
//   task show  prints this node's tasks and task requests, or one of them
//   task new   a session asks for a task, only on the operator's explicit
//              directive in that session, quoted verbatim in --directive

export const TASK_USAGE = `usage:
  kherep-node task done <taskId> [--summary <text>]
  kherep-node task show [<taskId or requestId>]
  kherep-node task list
  kherep-node task new --title <title> --directive <the operator's instruction, verbatim> [--from <recorded-codex-session-id>] [--runtime claude|codex] [--os <os>]
    [--node <target-node-id>] [--cwd <dir>] [--capability <name>]... [--] <task text...>`;

export interface TaskArgs {
  positionals: string[];
  values: { summary?: string; title?: string; directive?: string; from?: string; node?: string; runtime?: string; os?: string; cwd?: string; capability?: string[] };
}

export interface TaskContext { paths: NodePaths; env: NodeJS.ProcessEnv; now?: () => number; out?: (line: string) => void; err?: (line: string) => void }

export function parseTaskArgs(argv: string[]): TaskArgs {
  return parseArgs({
    args: argv, allowPositionals: true,
    options: { summary: { type: "string" }, title: { type: "string" }, directive: { type: "string" }, runtime: { type: "string" },
      from: { type: "string" }, node: { type: "string" }, os: { type: "string" }, cwd: { type: "string" }, capability: { type: "string", multiple: true } },
  });
}

// Runs parsed arguments; the Worker tests call it directly (no node:util there).
export function runTaskArgs({ positionals, values }: TaskArgs, context: TaskContext): number {
  const out = context.out ?? ((line: string) => console.log(line));
  const err = context.err ?? ((line: string) => console.error(line));
  const now = context.now ?? Date.now;
  const fail = (message: string): number => { err(`kherep-node task: ${message}`); return 1; };
  const { paths, env } = context;
  const [command, ...rest] = positionals;
  if (values.from !== undefined && command !== "new") return fail("--from is only supported for task new");
  if (values.node !== undefined && command !== "new") return fail("--node is only supported for task new");

  if (command === "done" && rest.length === 1) {
    const [taskId] = rest;
    const record = isTaskId(taskId) ? readTask(paths, taskId) : null;
    if (!record) return fail(`task ${taskId} was not started on this node`);
    const self = sessionIdFromEnv(env);
    const own = taskForSession(paths, self);
    if (self && own?.taskId !== taskId) return fail(`this session was not started for task ${taskId}`);
    const summary = values.summary;
    if (summary !== undefined && (summary.length === 0 || summary.length > MAX_SUMMARY)) return fail(`--summary must be 1 to ${MAX_SUMMARY} characters`);
    queueReport(paths, { taskId, state: "done", ...(record.sessionId ? { sessionId: record.sessionId } : {}), ...(summary ? { summary } : {}) });
    // The process may still run: it stays under the limits until the watch sees it end.
    writeTask(paths, { ...record, state: "done", ...(isActive(record) ? { running: true } : {}) }, now());
    out(`task ${taskId} reported done`);
    return 0;
  }
  if ((command === "show" && rest.length === 0) || (command === "list" && rest.length === 0)) {
    for (const line of listTaskLines(paths)) out(line);
    return 0;
  }
  if (command === "show" && rest.length === 1) {
    const resolved = resolveTaskDetail(paths, rest[0]);
    if (!resolved.ok) return fail(resolved.error);
    out(JSON.stringify(resolved.detail, null, 2));
    return 0;
  }
  if (command === "new") return newTask(context, rest, values, now, out, fail);
  err(TASK_USAGE);
  return 2;
}

// Why this session may not request a task, or null: the checks `task new` and
// `msg send --new` share (no chains, the node's delegate.request, no active task).
export function delegationBlocked(paths: NodePaths, env: NodeJS.ProcessEnv, from?: string): string | null {
  if (taskForSession(paths, sessionIdFromEnv(env)) || (from && taskForSession(paths, from))) return NO_CHAINS;
  const policy = loadPolicy(readConfig(paths.config)?.policyFile ?? paths.policy);
  if (!policy.sessions?.delegate.request) return NOT_DELEGATING;
  return hasActiveTask(paths) ? TASKS_ACTIVE : null;
}

function newTask(context: TaskContext, words: string[], values: TaskArgs["values"], now: () => number, out: (line: string) => void,
  fail: (message: string) => number): number {
  const { paths, env } = context;
  if (values.node !== undefined && !isNodeId(values.node)) return fail("--node requires a full target node id");
  if (values.from !== undefined) {
    if (!isTaskId(values.from)) return fail("--from requires a full recorded Codex session id");
    if ([env[SESSION_ENV], env[KHEREP_SESSION_ENV]]
      .some(session => session !== undefined && session !== values.from)) {
      return fail("--from conflicts with the current runtime session");
    }
    let valid = false;
    try {
      const record = readCodexSession(paths, values.from);
      const seen = Date.parse(record?.lastSeen ?? "");
      valid = record?.sessionId === values.from && record.runtime === "codex" && Number.isFinite(seen)
        && seen <= now() + 5_000 && now() - seen <= CODEX_ACTIVE_MS;
    } catch { /* A failed hook-record read cannot establish sender identity. */ }
    if (!valid) return fail("--from requires a complete recent Codex hook record");
  }
  const blocked = delegationBlocked(paths, env, values.from);
  if (blocked) return fail(blocked);
  // Keep the exact id rather than a short alias that another recorded chat may share.
  const from = values.from !== undefined ? { ok: true as const, value: values.from } : senderSession(paths, env);
  if (!from.ok) return fail(from.error);
  const directive = values.directive ?? "";
  if (directive.trim() === "" || directive.length > MAX_DIRECTIVE) {
    return fail(`--directive is required: quote the operator's own instruction in this session verbatim (at most ${MAX_DIRECTIVE} characters)`);
  }
  const runtime = values.runtime ?? "claude";
  if (!SUPPORTED_RUNTIMES.includes(runtime as never)) return fail(`runtime ${runtime} is not supported; use claude or codex`);
  const requirements: TaskRequirements = { runtime: runtime as TaskRuntime, ...(values.os ? { os: values.os } : {}), ...(values.cwd ? { cwd: values.cwd } : {}),
    ...(values.node !== undefined ? { node: values.node } : {}),
    ...(values.capability?.length ? { capabilities: values.capability } : {}) };
  const text = words.join(" ");
  if (!isTaskTitle(values.title)) return fail("--title is required (one line, at most 200 characters)");
  if (!isTaskText(text) || !isTaskRequirements(requirements)) return fail("task text or requirements are invalid");
  const requestId = crypto.randomUUID();
  writeRequest(paths, { requestId, title: values.title, text, requirements, directive, requestedBy: from.value,
    requestedBySessionId: senderSessionId(paths, env, from.value), createdAt: new Date(now()).toISOString(), state: "pending" });
  out(requestId);
  return 0;
}

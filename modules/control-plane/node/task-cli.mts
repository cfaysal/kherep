import { parseArgs } from "node:util";

import {
  isTaskId, isTaskRequirements, isTaskText, isTaskTitle, MAX_DIRECTIVE, MAX_SUMMARY, SUPPORTED_RUNTIMES, type TaskRequirements,
  type TaskRuntime,
} from "../protocol-tasks.mts";
import { readConfig, type NodePaths } from "./config.mts";
import { senderSession, sessionIdFromEnv } from "./msg-resolve.mts";
import { loadPolicy } from "./policy.mts";
import { NO_CHAINS, NOT_DELEGATING, TASKS_ACTIVE } from "./task-exchange.mts";
import {
  hasActiveTask, isActive, listTasks, queueReport, readRequest, readTask, requestIds, taskForSession, writeRequest, writeTask,
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
  kherep-node task new --title <title> --directive <the operator's instruction, verbatim> [--runtime claude|codex] [--os <os>]
    [--cwd <dir>] [--capability <name>]... [--] <task text...>`;

export interface TaskArgs {
  positionals: string[];
  values: { summary?: string; title?: string; directive?: string; runtime?: string; os?: string; cwd?: string; capability?: string[] };
}

export interface TaskContext { paths: NodePaths; env: NodeJS.ProcessEnv; now?: () => number; out?: (line: string) => void; err?: (line: string) => void }

export function parseTaskArgs(argv: string[]): TaskArgs {
  return parseArgs({
    args: argv, allowPositionals: true,
    options: { summary: { type: "string" }, title: { type: "string" }, directive: { type: "string" }, runtime: { type: "string" },
      os: { type: "string" }, cwd: { type: "string" }, capability: { type: "string", multiple: true } },
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
  if (command === "show" && rest.length <= 1) {
    if (rest.length === 1) {
      const record = readTask(paths, rest[0]) ?? readRequest(paths, rest[0]);
      if (!record) return fail(`unknown task or request ${rest[0]}`);
      out(JSON.stringify(record, null, 2));
      return 0;
    }
    for (const t of listTasks(paths)) out(`task ${t.taskId}  ${t.state}  ${t.name}  ${t.sessionId ?? "-"}  ${t.cwd}`);
    for (const id of requestIds(paths)) {
      const r = readRequest(paths, id);
      if (r) out(`request ${r.requestId}  ${r.state}${r.taskId ? `  task ${r.taskId}` : ""}${r.reason ? `  ${r.reason}` : ""}`);
    }
    return 0;
  }
  if (command === "new") return newTask(context, rest, values, now, out, fail);
  err(TASK_USAGE);
  return 2;
}

function newTask(context: TaskContext, words: string[], values: TaskArgs["values"], now: () => number, out: (line: string) => void,
  fail: (message: string) => number): number {
  const { paths, env } = context;
  if (taskForSession(paths, sessionIdFromEnv(env))) return fail(NO_CHAINS);
  const policy = loadPolicy(readConfig(paths.config)?.policyFile ?? paths.policy);
  if (!policy.sessions?.delegate.request) return fail(NOT_DELEGATING);
  if (hasActiveTask(paths)) return fail(TASKS_ACTIVE);
  const from = senderSession(paths, env);
  if (!from.ok) return fail(from.error);
  const directive = values.directive ?? "";
  if (directive.trim() === "" || directive.length > MAX_DIRECTIVE) {
    return fail(`--directive is required: quote the operator's own instruction in this session verbatim (at most ${MAX_DIRECTIVE} characters)`);
  }
  const runtime = values.runtime ?? "claude";
  if (!SUPPORTED_RUNTIMES.includes(runtime as never)) return fail(`runtime ${runtime} is not supported; use claude or codex`);
  const requirements: TaskRequirements = { runtime: runtime as TaskRuntime, ...(values.os ? { os: values.os } : {}), ...(values.cwd ? { cwd: values.cwd } : {}),
    ...(values.capability?.length ? { capabilities: values.capability } : {}) };
  const text = words.join(" ");
  if (!isTaskTitle(values.title)) return fail("--title is required (one line, at most 200 characters)");
  if (!isTaskText(text) || !isTaskRequirements(requirements)) return fail("task text or requirements are invalid");
  const requestId = crypto.randomUUID();
  writeRequest(paths, { requestId, title: values.title, text, requirements, directive, requestedBy: from.value,
    createdAt: new Date(now()).toISOString(), state: "pending" });
  out(requestId);
  return 0;
}

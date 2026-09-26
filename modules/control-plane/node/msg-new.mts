import {
  intercomLabel, isTaskLabel, isTaskRequirements, isTaskText, MAX_DIRECTIVE, SUPPORTED_RUNTIMES, type TaskRequirements, type TaskRuntime,
} from "../protocol-tasks.mts";
import type { DirectoryBody } from "../protocol-messages.mts";
import { isCodexSession } from "./codex-sessions.mts";
import { readConfig, type NodePaths } from "./config.mts";
import { KHEREP_SESSION_ENV, resolveNode, senderSession, SESSION_ENV } from "./msg-resolve.mts";
import { delegationBlocked } from "./task-cli.mts";
import { readRequest, writeRequest } from "./task-records.mts";

// kherep-node msg send <node> --new <claude|codex> (issue #74): the first
// message of a conversation, sent to a new intercom session instead of an
// existing one. It is a delegated task request targeted at exactly that node,
// labelled "intercom: <own runtime>@<own node name>", with the text as the
// task prompt. The operator chooses between an existing session and --new
// before the first message; the session never chooses on its own (ROUTING).

// --directive is required and quotes the operator's answer verbatim: there is
// no default, since a default would claim an operator choice nobody made.
export const DIRECTIVE_REQUIRED = "--new needs --directive with the operator's answer";
export const DEFAULT_NEW_WAIT_S = 30;
const POLL_MS = 250;

export interface NewIo {
  paths: NodePaths; env: NodeJS.ProcessEnv; now: () => number; out: (line: string) => void; err: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
}

export interface NewValues { new?: string; cwd?: string; directive?: string; from?: string; wait?: string }

// This session's runtime: Codex when --from names a recorded Codex session or
// the node set KHEREP_SESSION_ID alone, Claude when Claude Code set its id.
export function ownRuntime(paths: NodePaths, env: NodeJS.ProcessEnv, from?: string): TaskRuntime | null {
  if (from !== undefined && isCodexSession(paths, from)) return "codex";
  if (env[SESSION_ENV]) return "claude";
  return env[KHEREP_SESSION_ENV] ? "codex" : null;
}

export async function sendNew(io: NewIo, directory: DirectoryBody, target: string, words: string[], values: NewValues): Promise<number> {
  const fail = (message: string): number => { io.err(`kherep-node msg: ${message}`); return 1; };
  const runtime = values.new as string;
  if (!SUPPORTED_RUNTIMES.includes(runtime as TaskRuntime)) return fail(`--new takes claude or codex, got "${runtime}"`);
  const directive = values.directive;
  if (directive === undefined || directive.trim() === "") return fail(DIRECTIVE_REQUIRED);
  if (directive.length > MAX_DIRECTIVE) return fail(`--directive must be at most ${MAX_DIRECTIVE} characters`);
  const blocked = delegationBlocked(io.paths, io.env);
  if (blocked) return fail(blocked);
  const node = resolveNode(directory, target);
  if (!node.ok) return fail(node.error);
  const config = readConfig(io.paths.config);
  const selfName = directory.nodes.find((n) => n.nodeId === config?.nodeId)?.name ?? config?.name;
  const own = ownRuntime(io.paths, io.env, values.from);
  if (!own) return fail(`cannot tell this session's runtime: ${SESSION_ENV} is not set; pass --from <session>`);
  const label = intercomLabel(own, selfName ?? "");
  if (!selfName || !isTaskLabel(label)) {
    return fail(`this node's name "${selfName ?? ""}" cannot form a label (letters, digits, space, : @ - _ . and at most 64 characters)`);
  }
  const from = senderSession(io.paths, io.env, values.from);
  if (!from.ok) return fail(from.error);
  const text = words.join(" ");
  if (!isTaskText(text)) return fail("the first message must be 1 to 16384 characters");
  const requirements: TaskRequirements = { runtime: runtime as TaskRuntime, node: node.value.nodeId, ...(values.cwd ? { cwd: values.cwd } : {}) };
  if (!isTaskRequirements(requirements)) return fail("--cwd must be one line of at most 1024 characters");
  const wait = values.wait === undefined ? DEFAULT_NEW_WAIT_S : Number(values.wait);
  if (!Number.isFinite(wait) || wait < 0) return fail(`--wait needs a number of seconds, got "${values.wait}"`);
  const requestId = crypto.randomUUID();
  writeRequest(io.paths, { requestId, title: label, text, requirements, directive, requestedBy: from.value, label,
    createdAt: new Date(io.now()).toISOString(), state: "pending" });
  return waitForTask(io, requestId, wait * 1000, fail);
}

// Waits for the Worker's answer, which the daemon writes into the request file.
async function waitForTask(io: NewIo, requestId: string, timeoutMs: number, fail: (message: string) => number): Promise<number> {
  const deadline = io.now() + timeoutMs;
  for (;;) {
    const record = readRequest(io.paths, requestId);
    if (record?.state === "dispatched" && record.taskId) {
      io.out(record.taskId);
      return 0;
    }
    if (record?.state === "refused") return fail(`refused: ${record.reason ?? "no reason given"} (request ${requestId})`);
    if (io.now() >= deadline) {
      return fail(`request ${requestId} is still pending: is the daemon running? \`task show ${requestId}\` shows the answer later`);
    }
    await io.sleep(POLL_MS);
  }
}

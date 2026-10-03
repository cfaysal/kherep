import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  isMessageId, isMessageText, MAX_MESSAGE_TEXT, OPERATOR_NODE_ID, senderState, silentlyAccepted, type DirectoryBody, type MessageAddress,
} from "../protocol-messages.mts";
import { readConfig, type NodePaths } from "./config.mts";
import { getOutbox, getSent, readDirectory, requestDirectory, writeOutbox, type OutboxRecord, type SentRecord,
} from "./exchange.mts";
import { getMessage, markAnswered } from "./inbox.mts";
import {
  currentSession, DIRECTORY_STALE_MS, resolveSendTarget, senderSession, SESSION_ENV, sessionIdFromEnv,
} from "./msg-resolve.mts";
import { inbox } from "./msg-inbox.mts";
import { sendNew } from "./msg-new.mts";
import { taskForSession } from "./task-records.mts";

// kherep-node msg: the session side of messaging (issue #31, step 3a). It only
// reads and writes files in the node's config directory; the daemon does the
// network part.

export const CLI_PATH = fileURLToPath(new URL("./cli.mts", import.meta.url).href);

// The command line a session runs to reach this CLI.
export function cliCommand(): string {
  return `node "${CLI_PATH}"`;
}

// The command line a task session runs (issue #79), with this CLI by absolute
// path in single quotes, which keep it literal. On macOS and Linux the daemon's
// own node goes by absolute path too. On Windows a session may run it through
// Git Bash (Claude's Bash tool) or PowerShell (Codex), so the line must work in
// both: bare `node` (the task's PATH starts with the daemon's node directory,
// task-env.mts) and the CLI path with forward slashes. No quoting of a single
// quote works in both shells, so such a path is refused.
export function taskCliCommand(platform: NodeJS.Platform = process.platform, node: string = process.execPath, cli: string = CLI_PATH): string {
  if (platform === "win32") {
    if (cli.includes("'")) throw new Error("the kherep-node CLI path contains a single quote, which no command line can quote for both Git Bash and PowerShell");
    return `node '${cli.replaceAll("\\", "/")}'`;
  }
  const quote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;
  return `${quote(node)} ${quote(cli)}`;
}

export const MSG_USAGE = `usage:
  kherep-node msg sessions
  kherep-node msg send <node>/<session> [--from <session>] [--wait <seconds>] [--] <text...>
  kherep-node msg send <node> --new claude|codex --directive <the operator's answer, verbatim> [--cwd <dir>] [--from <session>] [--wait <seconds>] [--] <text...>
  kherep-node msg send --reply-to <messageId> [--to <node>/<session>] [--from <session>] [--wait <seconds>] [--] <text...>
  kherep-node msg inbox [--from <codex-session-id>] [--all | --receive]
  kherep-node msg status <messageId>`;

const FINAL_OK = ["accepted", "delivered", "replied"];
const WAIT_POLL_MS = 250;

const PROGRESS_TEXT: Record<string, string> = {
  "awaiting-user-turn": "waiting for the target session's next turn; delivery is not confirmed",
  "awaiting-turn-confirmation": "the target turn received it and has not confirmed completion",
  "target-busy": "the target session is busy",
  "wake-unconfirmed": "the automatic wake was not confirmed; start the target turn to retry delivery",
  "retry-pending": "delivery will retry after the current local limit clears",
  "wake-disabled": "automatic wake is disabled on the target node; start the target turn to retry delivery",
  "wake-not-authorized": "the target node did not authorize automatic wake; start the target turn to retry delivery",
  "permission-restricted": "the target permission mode blocks automatic wake; start the target turn to retry delivery",
  "operator-stopped": "the target session was stopped by its operator and requires an explicit continue",
  "reply-limit": "the automatic reply depth limit was reached",
  "budget-exhausted": "the target's autonomous-turn budget is exhausted",
  "ambiguous-target": "the target session name is ambiguous; send to its full session id",
  "wake-pending": "awaiting automatic wake confirmation",
  "fallback-starting": "a local delivery session is starting",
  "fallback-running": "a local delivery session is running",
  "wake-failed": "the automatic wake failed; start the target turn to retry delivery",
  "fallback-failed": "the local delivery session failed; delivery is not confirmed",
};

// The sender state (accepted, running, stopped, ...) with its reason (issue #197).
function stateText(record: SentRecord, now: number): string {
  const state = senderState(record.state, record.progress);
  if (silentlyAccepted(record.state, record.progress, Date.parse(record.updatedAt), now)) {
    return `${state}: no delivery progress from the target node since ${record.updatedAt}; the target session may not be running`
      + " (refused after 60 minutes), or the target node is offline or runs an older kherep-node; check `kherep-node msg sessions`";
  }
  return `${state}${progressText(record)}`;
}

function progressText(record: SentRecord): string {
  if (!record.progress) return record.reason ? `: ${record.reason}` : "";
  const retry = record.progress.retryAt ? `; retry after ${record.progress.retryAt}` : "";
  return `: ${PROGRESS_TEXT[record.progress.code]} [${record.progress.phase}/${record.progress.code}; observed ${record.progress.observedAt}${retry}]`;
}

export interface MsgContext {
  paths: NodePaths;
  env: NodeJS.ProcessEnv;
  now?: () => number;
  out?: (line: string) => void;
  err?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

type Io = Required<MsgContext>;

function fail(io: Io, message: string): number {
  io.err(`kherep-node msg: ${message}`);
  return 1;
}

export interface MsgArgs {
  positionals: string[];
  values: { from?: string; to?: string; "reply-to"?: string; wait?: string; all?: boolean; receive?: boolean; new?: string; cwd?: string; directive?: string };
}

export function parseMsgArgs(argv: string[]): MsgArgs {
  return parseArgs({
    args: argv, allowPositionals: true,
    options: { from: { type: "string" }, to: { type: "string" }, "reply-to": { type: "string" }, wait: { type: "string" }, all: { type: "boolean" }, receive: { type: "boolean" },
      new: { type: "string" }, cwd: { type: "string" }, directive: { type: "string" } },
  });
}

export function runMsg(argv: string[], context: MsgContext): Promise<number> {
  return runMsgArgs(parseMsgArgs(argv), context);
}

// Runs parsed arguments; the Worker tests call it directly because workerd
// has no node:util parseArgs.
export async function runMsgArgs({ positionals, values }: MsgArgs, context: MsgContext): Promise<number> {
  const io: Io = {
    paths: context.paths, env: context.env, now: context.now ?? Date.now,
    out: context.out ?? ((line) => console.log(line)), err: context.err ?? ((line) => console.error(line)),
    sleep: context.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
  const [command, ...rest] = positionals;
  if (command === "sessions") return sessions(io);
  if (command === "send") return send(io, rest, values);
  if (command === "inbox") return inbox(io, values);
  if (command === "status" && rest.length === 1) return status(io, rest[0]);
  io.err(MSG_USAGE);
  return 2;
}

// The directory, with a warning when it is old. A missing one is an error,
// never an empty list. Every read also asks the daemon for a fresh copy.
// attach.mts reads the directory the same way.
export function directoryFor(io: Pick<Io, "paths" | "now" | "err">): DirectoryBody | null {
  try {
    requestDirectory(io.paths);
  } catch {
    // the read below still reports what is there
  }
  const directory = readDirectory(io.paths);
  if (!directory) {
    io.err("kherep-node msg: no session directory yet (directory.json is missing or unreadable). Is the daemon running? A refresh was requested.");
    return null;
  }
  const age = io.now() - Date.parse(directory.fetchedAt);
  if (age > DIRECTORY_STALE_MS) {
    io.err(`warning: the session directory is ${Math.round(age / 60_000)} min old (fetched ${directory.fetchedAt}); is the daemon running?`);
  }
  if (directory.truncated) io.err("warning: the session directory was truncated by the control plane; some sessions are not listed");
  return directory;
}

function sessions(io: Io): number {
  const directory = directoryFor(io);
  if (!directory) return 1;
  const nodeId = readConfig(io.paths.config)?.nodeId;
  const me = currentSession(io.paths, io.env);
  for (const node of directory.nodes) {
    io.out(`${node.name} (${node.nodeId}) ${node.status}${node.nodeId === nodeId ? " [this node]" : ""}`);
    const list = directory.sessions.filter((s) => s.nodeId === node.nodeId);
    if (list.length === 0) io.out("    no sessions reported");
    for (const s of list) {
      const mine = node.nodeId === nodeId && s.sessionId === me?.id;
      // A Codex thread title (issue #88) is display only, quoted as a JSON string.
      const title = s.title ? `  ${JSON.stringify(s.title)}` : "";
      io.out(`  ${mine ? "*" : " "} ${s.label ?? s.name ?? "-"}${title}  ${s.sessionId}  ${s.state}  ${s.runtime}${s.cwd ? `  ${s.cwd}` : ""}`);
    }
  }
  io.out(`(* marks this session${me ? "" : `; ${SESSION_ENV} is not set, so none is marked`})`);
  return 0;
}

async function send(io: Io, rest: string[], values: MsgArgs["values"]): Promise<number> {
  const replyTo = values["reply-to"];
  if (values.new !== undefined) {
    if (replyTo !== undefined || values.to !== undefined) return fail(io, "--new starts a conversation and takes neither --reply-to nor --to");
    const [node, ...words] = rest;
    if (!node) return fail(io, `no target node\n${MSG_USAGE}`);
    const directory = directoryFor(io);
    return directory ? sendNew(io, directory, node, words, values) : 1;
  }
  if (values.cwd !== undefined || values.directive !== undefined) return fail(io, "--cwd and --directive go with --new");
  let to: MessageAddress | null = null;
  let target = values.to;
  let words = rest;
  // A reply is one hop deeper than the message it answers, and belongs to its task.
  let depth = 0;
  let taskId: string | undefined;
  if (replyTo !== undefined) {
    if (!isMessageId(replyTo)) return fail(io, `--reply-to needs a message id, got "${replyTo}"`);
    const original = getMessage(io.paths.inbox, replyTo);
    if (!original) return fail(io, `message ${replyTo} is not in this node's inbox`);
    depth = (original.depth ?? 0) + 1;
    taskId = original.taskId;
    if (!target) {
      if (original.from.nodeId === OPERATOR_NODE_ID) return fail(io, "the message came from the operator API and cannot be answered with msg send");
      to = { nodeId: original.from.nodeId, session: original.from.session };
    }
  } else {
    [target, ...words] = rest;
    if (!target) return fail(io, `no target\n${MSG_USAGE}`);
  }
  if (!to) {
    const directory = directoryFor(io);
    if (!directory) return 1;
    const resolved = resolveSendTarget(directory, target as string);
    if (!resolved.ok) return fail(io, resolved.error);
    to = resolved.value;
    if (resolved.note) io.err(`kherep-node msg: note: ${resolved.note}`);
  }
  const text = words.join(" ");
  if (!isMessageText(text)) return fail(io, `message text must be 1 to ${MAX_MESSAGE_TEXT} characters`);
  const from = senderSession(io.paths, io.env, values.from);
  if (!from.ok) return fail(io, from.error);
  const wait = values.wait === undefined ? 0 : Number(values.wait);
  if (!Number.isFinite(wait) || wait < 0) return fail(io, `--wait needs a number of seconds, got "${values.wait}"`);

  // A session started for a task tags its messages with that task (item 5).
  // A task the Worker does not know (issue #102) tags nothing.
  const own = taskForSession(io.paths, sessionIdFromEnv(io.env));
  taskId = (own && !own.local ? own.taskId : undefined) ?? taskId;
  const record: OutboxRecord = { messageId: crypto.randomUUID(), fromSession: from.value, to, text,
    ...(replyTo ? { inReplyTo: replyTo } : {}), ...(taskId ? { taskId } : {}), createdAt: new Date(io.now()).toISOString(), depth };
  writeOutbox(io.paths, record);
  if (replyTo) markAnswered(io.paths.inbox, replyTo);
  io.out(record.messageId);
  return wait > 0 ? waitForAnswer(io, record.messageId, wait * 1000) : 0;
}

// Waits until the target node accepted or refused the message, or the Worker
// gave up on it. queued is not an answer yet.
async function waitForAnswer(io: Io, messageId: string, timeoutMs: number): Promise<number> {
  const deadline = io.now() + timeoutMs;
  for (;;) {
    const sent = getSent(io.paths, messageId);
    if (sent && sent.state !== "queued") {
      io.out(stateText(sent, io.now()));
      return FINAL_OK.includes(sent.state) ? 0 : 1;
    }
    if (io.now() >= deadline) {
      io.out(`no answer yet: ${sent ? sent.state : "not sent by the daemon yet"}`);
      return 1;
    }
    await io.sleep(WAIT_POLL_MS);
  }
}

function status(io: Io, messageId: string): number {
  if (!isMessageId(messageId)) return fail(io, `not a message id: "${messageId}"`);
  const sent = getSent(io.paths, messageId);
  if (sent) {
    io.out(`${messageId} ${stateText(sent, io.now())} (updated ${sent.updatedAt})`);
    return 0;
  }
  if (getOutbox(io.paths, messageId)) {
    io.out(`${messageId} pending: waiting for the daemon to send it`);
    return 0;
  }
  return fail(io, `unknown message ${messageId}: not in the outbox or sent messages of this node`);
}

import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  isMessageId, isMessageText, MAX_MESSAGE_TEXT, OPERATOR_NODE_ID, type DirectoryBody, type MessageAddress,
} from "../protocol-messages.mts";
import { readConfig, type NodePaths } from "./config.mts";
import { getOutbox, getSent, readDirectory, requestDirectory, writeOutbox, type OutboxRecord } from "./exchange.mts";
import { getMessage, listInbox } from "./inbox.mts";
import {
  currentSession, DIRECTORY_STALE_MS, nodeLabel, resolveTarget, senderSession, SESSION_ENV, sessionIdFromEnv,
} from "./msg-resolve.mts";
import { taskForSession } from "./task-records.mts";

// kherep-node msg: the session side of messaging (issue #31, step 3a). It only
// reads and writes files in the node's config directory; the daemon does the
// network part.

export const CLI_PATH = fileURLToPath(new URL("./cli.mts", import.meta.url).href);

// The command line a session runs to reach this CLI.
export function cliCommand(): string {
  return `node "${CLI_PATH}"`;
}

export const MSG_USAGE = `usage:
  kherep-node msg sessions
  kherep-node msg send <node>/<session> [--from <session>] [--wait <seconds>] [--] <text...>
  kherep-node msg send --reply-to <messageId> [--to <node>/<session>] [--from <session>] [--wait <seconds>] [--] <text...>
  kherep-node msg inbox [--all]
  kherep-node msg status <messageId>`;

const FINAL_OK = ["accepted", "delivered", "replied"];
const WAIT_POLL_MS = 250;

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
  values: { from?: string; to?: string; "reply-to"?: string; wait?: string; all?: boolean };
}

export function parseMsgArgs(argv: string[]): MsgArgs {
  return parseArgs({
    args: argv, allowPositionals: true,
    options: { from: { type: "string" }, to: { type: "string" }, "reply-to": { type: "string" }, wait: { type: "string" }, all: { type: "boolean" } },
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
  if (command === "inbox") return inbox(io, values.all === true);
  if (command === "status" && rest.length === 1) return status(io, rest[0]);
  io.err(MSG_USAGE);
  return 2;
}

// The directory, with a warning when it is old. A missing one is an error,
// never an empty list. Every read also asks the daemon for a fresh copy.
function directoryFor(io: Io): DirectoryBody | null {
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
      io.out(`  ${mine ? "*" : " "} ${s.name ?? "-"}  ${s.sessionId}  ${s.state}  ${s.runtime}${s.cwd ? `  ${s.cwd}` : ""}`);
    }
  }
  io.out(`(* marks this session${me ? "" : `; ${SESSION_ENV} is not set, so none is marked`})`);
  return 0;
}

async function send(io: Io, rest: string[], values: MsgArgs["values"]): Promise<number> {
  const replyTo = values["reply-to"];
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
    const resolved = resolveTarget(directory, target as string);
    if (!resolved.ok) return fail(io, resolved.error);
    to = resolved.value;
  }
  const text = words.join(" ");
  if (!isMessageText(text)) return fail(io, `message text must be 1 to ${MAX_MESSAGE_TEXT} characters`);
  const from = senderSession(io.paths, io.env, values.from);
  if (!from.ok) return fail(io, from.error);
  const wait = values.wait === undefined ? 0 : Number(values.wait);
  if (!Number.isFinite(wait) || wait < 0) return fail(io, `--wait needs a number of seconds, got "${values.wait}"`);

  // A session started for a task tags its messages with that task (item 5).
  taskId = taskForSession(io.paths, sessionIdFromEnv(io.env))?.taskId ?? taskId;
  const record: OutboxRecord = { messageId: crypto.randomUUID(), fromSession: from.value, to, text,
    ...(replyTo ? { inReplyTo: replyTo } : {}), ...(taskId ? { taskId } : {}), createdAt: new Date(io.now()).toISOString(), depth };
  writeOutbox(io.paths, record);
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
      io.out(`${sent.state}${sent.reason ? `: ${sent.reason}` : ""}`);
      return FINAL_OK.includes(sent.state) ? 0 : 1;
    }
    if (io.now() >= deadline) {
      io.out(`no answer yet: ${sent ? sent.state : "not sent by the daemon yet"}`);
      return 1;
    }
    await io.sleep(WAIT_POLL_MS);
  }
}

// Messages addressed to this session by its id or its name. Without --all
// only those the delivery hook has not confirmed as delivered yet.
function inbox(io: Io, all: boolean): number {
  const me = currentSession(io.paths, io.env);
  if (!me) return fail(io, `cannot tell which session this is: ${SESSION_ENV} is not set`);
  const records = listInbox(io.paths.inbox)
    .filter((r) => r.toSession === me.id || (me.name !== undefined && r.toSession === me.name))
    .filter((r) => all || r.state === "accepted" || r.state === "offered");
  if (records.length === 0) {
    io.out(all ? "no messages for this session" : "no undelivered messages for this session (--all includes delivered ones)");
    return 0;
  }
  const directory = readDirectory(io.paths);
  for (const r of records) {
    io.out(`${r.messageId}  ${r.state}  ${r.createdAt}`);
    io.out(`  from: node ${nodeLabel(directory, r.from.nodeId)}, session ${r.from.session}`);
    if (r.inReplyTo) io.out(`  in reply to: ${r.inReplyTo}`);
    for (const line of r.text.split("\n")) io.out(`  | ${line}`);
  }
  return 0;
}

function status(io: Io, messageId: string): number {
  if (!isMessageId(messageId)) return fail(io, `not a message id: "${messageId}"`);
  const sent = getSent(io.paths, messageId);
  if (sent) {
    io.out(`${messageId} ${sent.state}${sent.reason ? `: ${sent.reason}` : ""} (updated ${sent.updatedAt})`);
    return 0;
  }
  if (getOutbox(io.paths, messageId)) {
    io.out(`${messageId} pending: waiting for the daemon to send it`);
    return 0;
  }
  return fail(io, `unknown message ${messageId}: not in the outbox or sent messages of this node`);
}

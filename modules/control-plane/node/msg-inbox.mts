import { codexSessionRefs, listCodexSessions, readCodexSession } from "./codex-sessions.mts";
import { CODEX_CONTEXT_BYTES, CODEX_ESCALATION_NOTE } from "./deliver-codex.mts";
import { deliveryContext } from "./deliver-core.mts";
import type { NodePaths } from "./config.mts";
import { readDirectory, type LocalSession, type SentRecord } from "./exchange.mts";
import { listInbox, readJson } from "./inbox.mts";
import type { MsgArgs, MsgContext } from "./msg-cli.mts";
import { NO_SESSION, nodeLabel, senderSession, sessionIdFromEnv } from "./msg-resolve.mts";

type InboxIo = Required<MsgContext>;

// Inspection is read-only. --receive offers bounded peer context to the current
// Codex continuation; its next Stop confirms that the carrying turn completed.
export function inbox(io: InboxIo, values: MsgArgs["values"]): number {
  const fail = (message: string): number => { io.err("kherep-node msg: " + message); return 1; };
  if (values.receive && values.all) return fail("--receive cannot be combined with --all");
  if (values.receive && !values.from) return fail("--receive needs --from with the recorded Codex session id");

  let refs: string[];
  if (values.from !== undefined) {
    try {
      const session = readCodexSession(io.paths, values.from);
      if (!session || session.sessionId !== values.from || session.runtime !== "codex") {
        return fail("--from needs a recorded Codex session id for inbox access");
      }
      const verified = senderSession(io.paths, io.env, values.from, io.now());
      if (!verified.ok) return fail(verified.error);
      // An unsuccessful listing cannot prove an alias is unambiguous.
      const live = listCodexSessions(io.paths, io.now()).map(s => s.sessionId);
      refs = codexSessionRefs(io.paths, values.from, io.now(), live).refs;
    } catch {
      return fail("cannot read Codex sessions safely; inbox was not received");
    }
  } else {
    const id = sessionIdFromEnv(io.env);
    if (!id) return fail(NO_SESSION);
    refs = [id];
    try {
      const sessions = readJson<{ sessions?: LocalSession[] }>(io.paths.sessions)?.sessions;
      if (!Array.isArray(sessions) || !sessions.every(s => s && typeof s.sessionId === "string" && s.sessionId.length > 0
        && (s.name === undefined || (typeof s.name === "string" && s.name.length > 0)))) {
        throw new Error("invalid local sessions");
      }
      const name = sessions.find(s => s.sessionId === id)?.name;
      const matches = name ? sessions.filter(s => s.sessionId === name || s.name === name) : [];
      if (name && matches.length === 1 && matches[0].sessionId === id) refs.push(name);
    } catch {
      io.err("kherep-node msg: cannot verify local session names; inspecting only the exact session id");
    }
  }

  if (values.receive) {
    const context = deliveryContext("UserPromptSubmit", refs, {
      paths: io.paths, now: io.now, replyFrom: values.from,
      maxBytes: CODEX_CONTEXT_BYTES - Buffer.byteLength(CODEX_ESCALATION_NOTE) - 1,
      reofferOffered: false,
    });
    io.out(context ? context + "\n" + CODEX_ESCALATION_NOTE : "no messages waiting for this continuation");
    return 0;
  }
  const records = listInbox(io.paths.inbox)
    .filter(r => refs.includes(r.toSession) || (r.closedTo !== undefined && refs.includes(r.closedTo)))
    .filter(r => values.all || r.state === "accepted" || r.state === "offered");
  if (records.length === 0) {
    io.out(values.all ? "no messages for this session" : "no undelivered messages for this session (--all includes delivered ones)");
    return 0;
  }
  const directory = readDirectory(io.paths);
  for (const r of records) {
    io.out(r.messageId + "  " + r.state + "  " + r.createdAt);
    io.out("  from: node " + nodeLabel(directory, r.from.nodeId) + ", session " + r.from.session);
    if (r.inReplyTo) io.out("  in reply to: " + r.inReplyTo);
    if (r.closedTo !== undefined) io.out("  forwarded to: session " + r.toSession);
    if (r.delivery) {
      io.out("  delivery task: " + r.delivery.taskId);
      if (r.delivery.sessionId) io.out("  delivery session: " + r.delivery.sessionId);
    }
    for (const line of r.text.split("\n")) io.out("  | " + line);
  }
  return 0;
}

// Issue #200: the replies to a sent message that reached this node, by the
// rule by which the Worker records replied: in reply to it, from its target
// node, to its sender session (or to that address before a fallback handover).
export function replyLines(paths: NodePaths, sent: SentRecord): string[] {
  const replies = listInbox(paths.inbox).filter((r) => r.inReplyTo === sent.messageId && r.from.nodeId === sent.to?.nodeId
    && (r.closedTo ?? r.toSession) === sent.fromSession);
  if (replies.length === 0) return [];
  const directory = readDirectory(paths);
  return replies.map((r) => `  reply ${r.messageId} from node ${nodeLabel(directory, r.from.nodeId)}, session ${r.from.session}`
    + ` (${r.state}, received ${r.receivedAt})`);
}

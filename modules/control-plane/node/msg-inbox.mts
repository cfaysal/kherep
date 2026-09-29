import { codexSessionRefs, listCodexSessions, readCodexSession } from "./codex-sessions.mts";
import { CODEX_CONTEXT_BYTES, CODEX_ESCALATION_NOTE } from "./deliver-codex.mts";
import { deliveryContext, sessionInbox } from "./deliver-core.mts";
import { readDirectory } from "./exchange.mts";
import type { MsgArgs, MsgContext } from "./msg-cli.mts";
import { currentSession, nodeLabel, SESSION_ENV } from "./msg-resolve.mts";

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
      // An unsuccessful listing cannot prove an alias is unambiguous.
      const live = listCodexSessions(io.paths, io.now()).map(s => s.sessionId);
      refs = codexSessionRefs(io.paths, values.from, io.now(), live).refs;
    } catch {
      return fail("cannot read Codex sessions safely; inbox was not received");
    }
  } else {
    const me = currentSession(io.paths, io.env);
    if (!me) return fail("cannot tell which session this is: " + SESSION_ENV + " is not set; Codex uses --from <session-id>");
    refs = [me.id, ...(me.name ? [me.name] : [])];
  }

  if (values.receive) {
    const context = deliveryContext("UserPromptSubmit", refs, {
      paths: io.paths, now: io.now, replyFrom: values.from,
      maxBytes: CODEX_CONTEXT_BYTES - Buffer.byteLength(CODEX_ESCALATION_NOTE) - 1,
    });
    io.out(context ? context + "\n" + CODEX_ESCALATION_NOTE : "no messages waiting for this continuation");
    return 0;
  }
  const records = sessionInbox(io.paths, refs).filter(r => values.all || r.state === "accepted" || r.state === "offered");
  if (records.length === 0) {
    io.out(values.all ? "no messages for this session" : "no undelivered messages for this session (--all includes delivered ones)");
    return 0;
  }
  const directory = readDirectory(io.paths);
  for (const r of records) {
    io.out(r.messageId + "  " + r.state + "  " + r.createdAt);
    io.out("  from: node " + nodeLabel(directory, r.from.nodeId) + ", session " + r.from.session);
    if (r.inReplyTo) io.out("  in reply to: " + r.inReplyTo);
    for (const line of r.text.split("\n")) io.out("  | " + line);
  }
  return 0;
}

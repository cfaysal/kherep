import { isNodeId } from "../protocol.mts";
import { isMessageId } from "../protocol-messages.mts";
import { audit, type AutonomyAction } from "./autonomy.mts";
import type { NodePaths } from "./config.mts";
import { getSent, type SentRecord } from "./exchange.mts";
import type { InboxRecord } from "./inbox.mts";
import type { NodePolicy } from "./policy.mts";
import { taskGrants, type TaskRecord } from "./task-records.mts";

// Reply grant (issue #253, operator decisions of 2026-10-05): with wake.replies
// a reply to a message this node sent from a session may wake that session
// without a listing. A per-message grant like the task grant, not a listing:
// wakeAllowed and explicitlyListed are unchanged, and every other guard
// (kill switch, bypassPermissions, reply depth, budget) applies as before.

// The original may be this old by the sender's own clock (sent createdAt).
export const REPLY_GRANT_MAX_AGE_MS = 24 * 60 * 60_000;

const ENDED: SentRecord["state"][] = ["refused", "expired", "error"];

// Whether record answers a message the session with these refs (its id and
// current name) sent, from the node it was sent to. The Worker sets from.nodeId
// from the authenticated connection but does not check inReplyTo, so the node
// clause stops a third node that knows a message id. The session binds by the
// id the sent record keeps; only a record without one (older version) falls
// back to its fromSession name. Any doubt or read error denies.
export function replyGrants(paths: NodePaths, refs: string[], record: InboxRecord, now: number): boolean {
  if (!isMessageId(record.inReplyTo) || !isNodeId(record.from?.nodeId)) return false;
  let sent: SentRecord | null;
  try {
    sent = getSent(paths, record.inReplyTo);
  } catch {
    return false;
  }
  if (!sent?.to || typeof sent.createdAt !== "string" || typeof sent.fromSession !== "string") return false;
  if (sent.to.nodeId !== record.from.nodeId) return false;
  if (!refs.includes(sent.fromSessionId ?? sent.fromSession)) return false;
  const age = now - Date.parse(sent.createdAt);
  return age >= 0 && age <= REPLY_GRANT_MAX_AGE_MS && !ENDED.includes(sent.state);
}

// What a listener its listing does not cover wakes for (wake-hook.mts): the
// records of its task grant and, with wake.replies, granted replies. reply
// collects the ids granted as replies only, for the audit.
export function unlistedGrants(paths: NodePaths, policy: NodePolicy, refs: string[], task: TaskRecord | undefined, now: number) {
  const reply = new Set<string>();
  const grants = (record: InboxRecord): boolean => {
    if (task && taskGrants(task, record)) return true;
    if (policy.wake?.replies !== true || !replyGrants(paths, refs, record, now)) return false;
    reply.add(record.messageId);
    return true;
  };
  return { grants, reply };
}

// One audit line for the ids woken through the listing or a task grant, one
// with grant "reply" for those only a reply granted.
export function auditGranted(paths: NodePaths, now: number, sessionId: string, ids: string[], action: AutonomyAction,
  reply: ReadonlySet<string>): void {
  const replies = ids.filter((id) => reply.has(id));
  const others = ids.filter((id) => !reply.has(id));
  if (others.length > 0) audit(paths, now, sessionId, others, action);
  if (replies.length > 0) audit(paths, now, sessionId, replies, action, "reply");
}

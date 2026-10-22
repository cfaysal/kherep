import path from "node:path";

import { isMessageId } from "../../protocol-messages.mts";
import type { TaskRuntime } from "../../protocol-tasks.mts";
import type { NodePaths } from "../config.mts";
import { getMessage, listInbox, setDeliveryTask, writeJsonAtomic, type InboxRecord } from "../inbox.mts";
import { withRecordLock } from "../inbox-record-lock.mts";
import type { TaskRecord } from "../task-records.mts";

// Retired (issue #638): the legacy session handover helpers, moved here from
// inbox.mts and delivery-identity.mts unchanged. No active module imports this
// file; only the tests that pin their previous contracts do. The active
// handover is task-handover.mts. The private support below copies the
// inbox.mts originals so their lock, re-read and write sequence is kept.

function fileOf(dir: string, messageId: string): string {
  return path.join(dir, `${messageId}.json`);
}

const runtimeOf = (task: TaskRecord): TaskRuntime => task.runtime ?? "claude";

type Update = { record: InboxRecord; written: boolean } | null;
function updateRecord(dir: string, messageId: string, change: (record: InboxRecord) => InboxRecord | null): Update {
  if (!isMessageId(messageId)) return null;
  return withRecordLock(dir, messageId, () => {
    const record = getMessage(dir, messageId);
    if (!record) return null;
    const next = change(record);
    if (next) writeJsonAtomic(fileOf(dir, messageId), next);
    return { record: next ?? record, written: next !== null };
  });
}

// Moves the waiting messages of a session to the copy Claude Code continued it
// as under a new id (issue #109); closedTo keeps the session they were sent to.
// Each record is judged again under its lock: one that another writer settled
// or moved since the listing stays, and is not among the returned ids.
export function readdress(dir: string, from: string, to: string): string[] {
  const waiting = (r: InboxRecord): boolean => (r.state === "accepted" || r.state === "offered") && r.toSession === from;
  return listInbox(dir, from).filter(waiting).filter((r) => updateRecord(dir, r.messageId,
    (record) => waiting(record) ? { ...record, toSession: to, closedTo: record.closedTo ?? from } : null)?.written)
    .map((r) => r.messageId);
}

export function updateDeliverySession(paths: NodePaths, task: TaskRecord, messageIds: string[], sessionId: string): void {
  for (const messageId of messageIds) {
    if (getMessage(paths.inbox, messageId)?.delivery?.taskId !== task.taskId) continue;
    setDeliveryTask(paths.inbox, messageId, { taskId: task.taskId, runtime: runtimeOf(task), sessionId });
  }
}

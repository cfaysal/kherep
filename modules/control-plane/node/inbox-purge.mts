import fs from "node:fs";
import path from "node:path";

import { isMessageId } from "../protocol-messages.mts";
import {
  getMessage, getReceipt, INBOX_RETENTION_MS, markRefused, progressFileOf, proxiedFileOf, receiptFileOf, type InboxRecord,
} from "./inbox.mts";
import { RecordLockBusy, withRecordLock } from "./inbox-record-lock.mts";

// The inbox purge, one step per directory entry (issue #581): the start
// maintenance runs it in time-bounded slices after the daemon connected
// (inbox-start.mts); purgeInbox drains it at once.

// Removes records received more than the retention period ago, and leftover
// temp and record lock files (#627) of that age. Returns the number of records
// removed. A record is never dropped while its sender could still see it
// accepted (issue #195): a waiting one is refused first, and a final one stays
// until a receipt confirms that state, or for one more retention period when no
// receipt comes; both are judged on the record under its lock, where the
// removal happens too, never on the copy listed above (#627). It walks
// the listing taken when it starts; an entry gone since then is skipped, and
// so is one written at or after touchedSince (wall clock): the sliced pass
// leaves a record another writer changed during the pass, such as a refusal
// not yet reported (#195), to the next start.
export function* purgeInboxSteps(dir: string, now: number = Date.now(), maxAgeMs: number = INBOX_RETENTION_MS,
  touchedSince: number = Infinity): Generator<void, number> {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let removed = 0;
  for (const name of entries) {
    yield;
    const file = path.join(dir, name);
    let received: number;
    try {
      received = fs.statSync(file).mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (received >= touchedSince) continue;
    let record: InboxRecord | null = null;
    if (name.endsWith(".json")) {
      try {
        record = JSON.parse(fs.readFileSync(file, "utf8")) as InboxRecord;
        const at = Date.parse(record.receivedAt);
        if (!Number.isNaN(at)) received = at;
      } catch {
        // unreadable record: its file time decides
      }
    } else if (!name.endsWith(".tmp") && !name.endsWith(".lock")) {
      continue;
    }
    if (now - received <= maxAgeMs) continue;
    if (record && isMessageId(record.messageId) && name === `${record.messageId}.json`) {
      if (markRefused(dir, record.messageId, "not delivered within the inbox retention period")) continue;
      if (!removeSettled(dir, record.messageId, file, received, now, maxAgeMs)) continue;
    } else {
      fs.rmSync(file, { force: true });
    }
    if (name.endsWith(".json")) {
      fs.rmSync(receiptFileOf(dir, name.slice(0, -5)), { force: true });
      fs.rmSync(progressFileOf(dir, name.slice(0, -5)), { force: true });
      if (isMessageId(name.slice(0, -5))) fs.rmSync(proxiedFileOf(dir, name.slice(0, -5)), { force: true });
      removed++;
    }
  }
  return removed;
}

// Removes a record whose state is final and confirmed by a receipt, or final
// and unconfirmed for a second retention period; false when it stays. State,
// receipt and removal are judged on the record under its lock (issue #627): the
// copy the listing read is stale once a writer in another process delivered
// the record meanwhile, and a receipt that confirmed the stale state would
// have dropped a delivery no receipt confirmed (#195). A record that still
// waits (its refusal above found it locked) and a lock that stays busy wait
// for the next pass; no writer can rewrite the record around the removal.
function removeSettled(dir: string, messageId: string, file: string, received: number, now: number, maxAgeMs: number): boolean {
  try {
    return withRecordLock(dir, messageId, () => {
      const current = getMessage(dir, messageId);
      if (!current || current.state === "accepted" || current.state === "offered") return false;
      const confirmed = getReceipt(dir, messageId)?.reportedState === current.state;
      if (!confirmed && now - received <= 2 * maxAgeMs) return false;
      fs.rmSync(file, { force: true });
      return true;
    });
  } catch (error) {
    if (error instanceof RecordLockBusy) return false;
    throw error;
  }
}

// Runs a step generator to its end and returns its result.
export function drain<T>(steps: Generator<void, T>): T {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

export function purgeInbox(dir: string, now: number = Date.now(), maxAgeMs: number = INBOX_RETENTION_MS): number {
  return drain(purgeInboxSteps(dir, now, maxAgeMs));
}

import type { InboxRecord } from "./inbox.mts";
import type { TaskRecord } from "./task-records.mts";

// Only fixed, known failure text may leave the local task record. CLI errors
// can contain private paths or credentials; never forward the raw reason.
export function permanentFallbackFailure(task: TaskRecord, message: InboxRecord, reason: string | undefined): string | null {
  if (task.runtime !== "codex" || task.local !== "intercom" || message.delivery?.runtime !== "codex"
    || message.delivery.taskId !== task.taskId || !message.closedTo) return null;
  return reason?.includes("model is not supported when using Codex with a ChatGPT account.")
    ? "Codex delivery fallback failed: the configured model is unavailable for this account; receipt in the original target session is not confirmed"
    : null;
}

export function exhaustedOfferReason(message: InboxRecord, maxOffers: number): string {
  return message.closedTo && message.delivery?.runtime === "codex"
    ? `Codex delivery fallback did not confirm the message after ${maxOffers} turns; receipt in the original target session is not confirmed`
    : `not confirmed by the session after ${maxOffers} turns`;
}

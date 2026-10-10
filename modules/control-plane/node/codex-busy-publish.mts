import crypto from "node:crypto";
import fs from "node:fs";

import { bypassesPermissions, listenerDir } from "./autonomy.mts";
import { publishBusyHint, type BusyHintAdmission } from "./codex-busy-ticket.mts";
import { CODEX_ACTIVE_MS, codexSessionRefs, readCodexSession } from "./codex-sessions.mts";
import { getMessage, MAX_REPLY_DEPTH, type InboxRecord } from "./inbox.mts";
import { explicitlyListed, readPolicy, type NodePolicy } from "./policy.mts";
import type { RunnerDeps } from "./session-runner.mts";
import { killSwitch } from "./wake-hook.mts";

export function busyPolicyFingerprint(policy: NodePolicy): string {
  return crypto.createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

// Called only after the existing queue guards and budget have admitted this
// owner. Copy addresses before the asynchronous queue lane; never retarget them.
export function captureBusyHint(deps: RunnerDeps, owner: string, due: InboxRecord[], now: number): BusyHintAdmission | null {
  try {
    return { owner, generation: crypto.randomUUID(), admittedAt: now, expiresAt: now + CODEX_ACTIVE_MS,
      policyFingerprint: busyPolicyFingerprint(deps.policy),
      messages: due.slice(0, 8).map(({ messageId, toSession }) => ({ messageId, toSession })) };
  } catch { return null; }
}

// A completed queue is an admission, never an offer or receipt. Metadata
// failure leaves that successful native queue and its attempt ledger intact.
export function publishAdmittedBusyHint(deps: RunnerDeps, ticket: BusyHintAdmission):
  ReturnType<typeof publishBusyHint> {
  try {
    const now = deps.now?.() ?? Date.now();
    const policy = readPolicy(deps.paths.policy, true);
    if (!policy || busyPolicyFingerprint(policy) !== ticket.policyFingerprint || fs.existsSync(killSwitch(deps.paths))) return "invalid";
    const mode = readCodexSession(deps.paths, ticket.owner)?.permissionMode;
    if (bypassesPermissions(mode) || (mode === undefined && !explicitlyListed(policy, [ticket.owner]))) return "invalid";
    const refs = new Set(ticket.messages.some((record) => record.toSession !== ticket.owner)
      ? codexSessionRefs(deps.paths, ticket.owner, now).refs : [ticket.owner]);
    const messages = ticket.messages.filter((admitted) => {
      const record = getMessage(deps.paths.inbox, admitted.messageId);
      const depth = record?.depth ?? 0;
      return record?.messageId === admitted.messageId && record.state === "accepted"
        && record.toSession === admitted.toSession && refs.has(admitted.toSession)
        && Number.isSafeInteger(depth) && depth >= 0 && depth < MAX_REPLY_DEPTH;
    });
    if (messages.length === 0) return "invalid";
    return publishBusyHint(listenerDir(deps.paths), { ...ticket, messages }, now);
  } catch { return "failed"; }
}

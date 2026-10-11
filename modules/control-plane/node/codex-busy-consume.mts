import fs from "node:fs";

import { bypassesPermissions, listenerDir } from "./autonomy.mts";
import { postToolOriginalOwner } from "./codex-hook-owner.mts";
import { busyPolicyFingerprint, busyWakeDisabled } from "./codex-busy-policy.mts";
import { claimBusyHint } from "./codex-busy-ticket.mts";
import { readCodexSession } from "./codex-sessions.mts";
import { contextOutput, type HookDeps } from "./deliver-core.mts";
import { getMessage, MAX_REPLY_DEPTH } from "./inbox.mts";
import { explicitlyListed, readPolicy } from "./policy.mts";

const HINT = "Kherep: New peer messages are waiting. Check this session's inbox and report any relevant update.";

// A metadata hint in the current original-owner turn. No discovery, offers,
// receipts, session ranking updates or extra turn budget at a tool boundary.
export function consumeBusyHint(input: unknown, deps: HookDeps): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const payload = input as Record<string, unknown>, owner = payload.session_id;
  if (typeof owner !== "string" || !postToolOriginalOwner(payload, owner)) return "";
  try {
    if (!fs.existsSync(deps.paths.config) || busyWakeDisabled(deps.paths)) return "";
    const policy = readPolicy(deps.paths.policy, true);
    if (!policy?.wake) return "";
    // A current Hook mode wins over the recorded mode. An explicitly unknown
    // Hook mode cannot borrow a previous normal mode to gain an automatic grant.
    const rawMode = Object.hasOwn(payload, "permission_mode") ? payload.permission_mode
      : readCodexSession(deps.paths, owner)?.permissionMode;
    const mode = typeof rawMode === "string" ? rawMode : undefined;
    if (bypassesPermissions(mode) || (mode === undefined && !explicitlyListed(policy, [owner]))) return "";
    const now = deps.now?.() ?? Date.now();
    const result = claimBusyHint(listenerDir(deps.paths), owner, busyPolicyFingerprint(policy), now, (ticket) => {
      let count = 0;
      for (const admitted of ticket.messages) {
        const record = getMessage(deps.paths.inbox, admitted.messageId);
        const depth = record?.depth ?? 0;
        if (record?.messageId === admitted.messageId && record.toSession === admitted.toSession && record.state === "accepted"
          && Number.isSafeInteger(depth) && depth >= 0 && depth < MAX_REPLY_DEPTH) count++;
      }
      return count;
    });
    return result.status === "hint" ? contextOutput("PostToolUse", HINT) : "";
  } catch {
    // Metadata/read/claim failure leaves the persistent CP Inbox intact.
    return "";
  }
}

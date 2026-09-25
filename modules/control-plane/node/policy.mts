import fs from "node:fs";

import { isNodeId, isPhase1Command, PHASE1_COMMANDS, type Phase1Command } from "../protocol.mts";
import { isSessionRef, MESSAGING_CAPABILITY, OPERATOR_NODE_ID } from "../protocol-messages.mts";

// Local allowlist (issue #5, design section 4). The node refuses any command
// outside this list even when it arrives authenticated from the control plane.
// The effective set is the intersection with the Phase 1 commands, so a policy
// file can narrow what runs here but never widen it.
//
// The optional messaging section (issue #31) lists which senders may leave a
// message for which local session. Without a rule nothing is accepted.
export interface AcceptRule { session: string; from: string[] }
export interface NodePolicy {
  version: 1;
  allowedCommands: Phase1Command[];
  messaging?: { accept: AcceptRule[] };
  wake?: { sessions: string[] };
}

export const DEFAULT_POLICY: NodePolicy = { version: 1, allowedCommands: [...PHASE1_COMMANDS] };

function denyAll(): NodePolicy {
  return { version: 1, allowedCommands: [] };
}

// A missing file means the default policy. An unreadable or malformed file
// fails closed: nothing is allowed until the operator fixes it.
export function loadPolicy(file: string): NodePolicy {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_POLICY;
    return denyAll();
  }
  try {
    const value = JSON.parse(text) as { version?: unknown; allowedCommands?: unknown; messaging?: unknown; wake?: unknown };
    if (value.version !== 1 || !Array.isArray(value.allowedCommands)) return denyAll();
    const accept = parseAcceptRules(value.messaging);
    const wake = parseWake(value.wake);
    return { version: 1, allowedCommands: value.allowedCommands.filter(isPhase1Command), ...(accept ? { messaging: { accept } } : {}),
      ...(wake ? { wake } : {}) };
  } catch {
    return denyAll();
  }
}

export function isAllowed(policy: NodePolicy, command: unknown): command is Phase1Command {
  return isPhase1Command(command) && policy.allowedCommands.includes(command);
}

const isSender = (value: unknown): boolean => value === "*" || value === OPERATOR_NODE_ID || isNodeId(value);

// A malformed messaging section disables messaging as a whole (fail closed);
// the command allowlist is unaffected.
function parseAcceptRules(section: unknown): AcceptRule[] | null {
  if (typeof section !== "object" || section === null) return null;
  const accept = (section as { accept?: unknown }).accept;
  if (!Array.isArray(accept)) return null;
  const rules: AcceptRule[] = [];
  for (const rule of accept) {
    const { session, from } = (rule ?? {}) as { session?: unknown; from?: unknown };
    if (!isSessionRef(session) || !Array.isArray(from) || from.length === 0 || !from.every(isSender)) return null;
    rules.push({ session, from: [...from] as string[] });
  }
  return rules.length > 0 ? rules : null;
}

export function messagingEnabled(policy: NodePolicy): boolean {
  return (policy.messaging?.accept.length ?? 0) > 0;
}

// What this node advertises in register: its allowed commands, plus
// messaging.v1 only when at least one accept rule exists.
export function advertisedCapabilities(policy: NodePolicy): string[] {
  return messagingEnabled(policy) ? [...policy.allowedCommands, MESSAGING_CAPABILITY] : [...policy.allowedCommands];
}

// session "*" matches any local session, from "*" any sender. Otherwise both
// match exactly: the session reference the sender addressed, or the id or
// current name of the local session it names (sessions: the last local
// listing), and the sender node id or "operator".
export function acceptsMessage(policy: NodePolicy, toSession: string, fromNodeId: string,
  sessions: { sessionId: string; name?: string }[] = []): boolean {
  const local = sessions.find((s) => s.sessionId === toSession || s.name === toSession);
  const refs = local ? [toSession, local.sessionId, ...(local.name ? [local.name] : [])] : [toSession];
  return (policy.messaging?.accept ?? []).some((rule) =>
    (rule.session === "*" || refs.includes(rule.session)) && (rule.from.includes("*") || rule.from.includes(fromNodeId)));
}

// The optional wake section (issue #31, operator decision 2026-09-25): waking
// idle sessions is opt-in per node and per session. Anything but enabled true
// with a non-empty list of session ids or names disables it (fail closed);
// "*" matches every session, but only where it is written.
function parseWake(section: unknown): { sessions: string[] } | null {
  if (typeof section !== "object" || section === null) return null;
  const { enabled, sessions } = section as { enabled?: unknown; sessions?: unknown };
  if (enabled !== true || !Array.isArray(sessions) || sessions.length === 0 || !sessions.every(isSessionRef)) return null;
  return { sessions: [...sessions] as string[] };
}

// refs: the session id and its current name, if any.
export function wakeAllowed(policy: NodePolicy, refs: string[]): boolean {
  const sessions = policy.wake?.sessions ?? [];
  return sessions.includes("*") || refs.some((ref) => sessions.includes(ref));
}

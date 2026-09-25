import fs from "node:fs";

import { isPhase1Command, PHASE1_COMMANDS, type Phase1Command } from "../protocol.mts";

// Local allowlist (issue #5, design section 4). The node refuses any command
// outside this list even when it arrives authenticated from the control plane.
// The effective set is the intersection with the Phase 1 commands, so a policy
// file can narrow what runs here but never widen it.
export interface NodePolicy {
  version: 1;
  allowedCommands: Phase1Command[];
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
    const value = JSON.parse(text) as { version?: unknown; allowedCommands?: unknown };
    if (value.version !== 1 || !Array.isArray(value.allowedCommands)) return denyAll();
    return { version: 1, allowedCommands: value.allowedCommands.filter(isPhase1Command) };
  } catch {
    return denyAll();
  }
}

export function isAllowed(policy: NodePolicy, command: unknown): command is Phase1Command {
  return isPhase1Command(command) && policy.allowedCommands.includes(command);
}

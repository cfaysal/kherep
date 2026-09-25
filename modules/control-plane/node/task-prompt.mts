import fs from "node:fs";
import path from "node:path";

import type { SessionsPolicy } from "./session-policy.mts";

// The text a started session gets (issue #31, item 5). The task text is the
// operator's own instruction, given through Cloudflare Access, or a session's
// request on the operator's directive, which the prompt quotes; it is not peer
// content. cli is the command line of this node's kherep-node CLI.

const doneHint = (taskId: string, cli: string): string =>
  `When you are done, report with: ${cli} task done ${taskId} --summary "...". Coordinate with other sessions of this task `
  + `through \`${cli} msg\` (your messages carry the task id automatically).`;

export interface Delegation { requestedBy: string; directive: string }

export function framePrompt(taskId: string, text: string, cli: string, delegation?: Delegation): string {
  if (!delegation) return `Task ${taskId} from the operator via the Kherep Control Plane: ${text}\n\n${doneHint(taskId, cli)}`;
  return `Task ${taskId} requested by session ${delegation.requestedBy} on the operator's directive, via the Kherep Control Plane. `
    + `The operator's directive, quoted: "${delegation.directive}"\n\nTask: ${text}\n\n${doneHint(taskId, cli)}`;
}

export function frameFollowUp(taskId: string, text: string, cli: string): string {
  return `Follow-up for task ${taskId} from the operator via the Kherep Control Plane: ${text}\n\n${doneHint(taskId, cli)}`;
}

export type Resolved = { ok: true; cwd: string } | { ok: false; reason: string };

// The working directory of a started session: the requested one, or the first
// workspace root. It must exist and, after resolving symbolic links and
// junctions, lie inside a workspace root, so a link cannot lead out of it.
export function resolveCwd(policy: SessionsPolicy, requested: string | undefined,
  realpath: (p: string) => string = fs.realpathSync.native): Resolved {
  const target = requested ?? policy.workspaceRoots[0];
  if (!target || !path.isAbsolute(target)) return { ok: false, reason: "cwd must be an absolute path" };
  let real: string;
  try {
    real = realpath(target);
  } catch {
    return { ok: false, reason: "cwd does not exist on this node" };
  }
  const inside = policy.workspaceRoots.some((root) => {
    let base: string;
    try {
      base = realpath(root);
    } catch {
      return false;
    }
    const relative = path.relative(base, real);
    return relative === "" || (relative.split(path.sep)[0] !== ".." && !path.isAbsolute(relative));
  });
  return inside ? { ok: true, cwd: real } : { ok: false, reason: "cwd is outside the workspace roots of this node" };
}

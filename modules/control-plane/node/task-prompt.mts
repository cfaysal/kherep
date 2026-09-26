import fs from "node:fs";
import path from "node:path";

import type { TaskRuntime } from "../protocol-tasks.mts";
import type { SessionsPolicy } from "./session-policy.mts";

// The text a started session gets (issue #31, item 5). The task text is the
// operator's own instruction, given through Cloudflare Access, or a session's
// request on the operator's directive, which the prompt quotes; it is not peer
// content. cli is the command line of this node's kherep-node CLI.

// A Codex run reports itself when it ends (issue #63): its last message is the
// summary, and its sandbox cannot write the node's task files anyway.
const doneHint = (taskId: string, cli: string, runtime: TaskRuntime): string =>
  (runtime === "codex" ? "When you are done, end your turn with a short summary; it is reported as the task's result. "
    : `When you are done, report with: ${cli} task done ${taskId} --summary "...". `)
  + `Coordinate with other sessions of this task through \`${cli} msg\` (your messages carry the task id automatically).`;

// label: set for an intercom session (issue #74), which the Control Plane
// starts for a conversation the requesting session opens with its first message.
export interface Delegation { requestedBy: string; directive: string; label?: string }

const intercomHint = (delegation: Delegation, cli: string): string => (delegation.label
  ? `This is an intercom session (${delegation.label}) for a conversation with session ${delegation.requestedBy}; `
    + `the task text is its first message. Answer it with: ${cli} msg send ${delegation.requestedBy} -- "<answer>". ` : "");

export function framePrompt(taskId: string, text: string, cli: string, delegation?: Delegation, runtime: TaskRuntime = "claude"): string {
  if (!delegation) return `Task ${taskId} from the operator via the Kherep Control Plane: ${text}\n\n${doneHint(taskId, cli, runtime)}`;
  return `Task ${taskId} requested by session ${delegation.requestedBy} on the operator's directive, via the Kherep Control Plane. `
    + `The operator's directive, quoted: "${delegation.directive}"\n\nTask: ${text}\n\n${intercomHint(delegation, cli)}${doneHint(taskId, cli, runtime)}`;
}

export function frameFollowUp(taskId: string, text: string, cli: string, runtime: TaskRuntime = "claude"): string {
  return `Follow-up for task ${taskId} from the operator via the Kherep Control Plane: ${text}\n\n${doneHint(taskId, cli, runtime)}`;
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

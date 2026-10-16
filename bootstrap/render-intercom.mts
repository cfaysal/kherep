// Issue #436. The intercom instructions both installers render: the Claude
// CLAUDE.md and ROUTING.md (install.sh, through render-profile.mts intercom) and
// the Codex AGENTS.md block and ROUTING.md (codex/install.mts). The command is
// launcherCommand() of this host's config root, the one string the rules and
// the doctor check name as well; nothing changes PATH.

import { configRoot, nodePaths, readConfig } from "../modules/control-plane/node/config.mts";
import { launcherCommand } from "../modules/control-plane/node/launcher.mts";

export const INTERCOM_COMMAND = "__KHEREP_NODE__";
export const INTERCOM_EXAMPLE_TARGET = "__KHEREP_EXAMPLE_TARGET__";

// The node name rule of onboard.mts; anything else gets the neutral example.
const NODE_NAME = /^[\w.-]{1,64}$/;

export interface IntercomValues { command: string; exampleTarget: string }

function exampleTarget(root: string): string {
  let name: unknown;
  try { name = readConfig(nodePaths(root).config)?.name; } catch { name = undefined; }
  return typeof name === "string" && NODE_NAME.test(name) ? `${name}/maestro` : "peer/session";
}

// A config root the launcher cannot quote for every shell throws here, before
// either installer changes a file.
export function intercomValues(root: string = configRoot(), platform: NodeJS.Platform = process.platform): IntercomValues {
  return { command: launcherCommand(root, platform), exampleTarget: exampleTarget(root) };
}

// Plain substitution (no replacement patterns); a rendered text has no
// placeholder left, so rendering it again changes nothing.
export function renderIntercom(text: string, values: IntercomValues): string {
  return text.split(INTERCOM_COMMAND).join(values.command).split(INTERCOM_EXAMPLE_TARGET).join(values.exampleTarget);
}

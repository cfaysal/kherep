import path from "node:path";

import { controlPlaneRulesPath, renderControlPlaneRules } from "../../../codex/lib/control-plane-rules.mts";
import { launcherCommand } from "./launcher.mts";

// Issue #436. The five files that must name the stable intercom command, and
// the text doctor and drift-check expect in each: the always-loaded Claude and
// Codex instructions, the two routing files and the Codex rules allowlist.
// PR B renders these files. Until it is merged, renderIntercomInstructions()
// stands in for its `__KHEREP_NODE__` substitution and expectedIntercomText()
// for what that rendering leaves in each file; both are the wiring seam.

export const INTERCOM_PLACEHOLDER = "__KHEREP_NODE__";

export const INTERCOM_INSTRUCTIONS = Object.freeze(
  ["claudeUser", "claudeRouting", "codexAgents", "codexRouting", "codexRules"] as const);
export type IntercomInstruction = (typeof INTERCOM_INSTRUCTIONS)[number];

export function intercomInstructionFiles(claudeDir: string, codexHome: string): Record<IntercomInstruction, string> {
  return {
    claudeUser: path.join(claudeDir, "CLAUDE.md"),
    claudeRouting: path.join(claudeDir, "teams", "kherep", "ROUTING.md"),
    codexAgents: path.join(codexHome, "AGENTS.md"),
    codexRouting: path.join(codexHome, "orchestra", "ROUTING.md"),
    codexRules: controlPlaneRulesPath(codexHome),
  };
}

// The launcher path as Codex tokenises launcherCommand(): the double-quoted word.
export function launcherToken(root: string, platform: NodeJS.Platform = process.platform): string {
  return launcherCommand(root, platform).slice('node "'.length, -1);
}

export function renderIntercomInstructions(text: string, root: string, platform: NodeJS.Platform = process.platform): string {
  return text.replaceAll(INTERCOM_PLACEHOLDER, launcherCommand(root, platform));
}

// A file is current when it holds this text: the command itself, or for the
// rules file the launcher's prefix_rule pattern line as the rules renderer
// writes it.
export function expectedIntercomText(kind: IntercomInstruction, root: string,
  platform: NodeJS.Platform = process.platform): string {
  if (kind !== "codexRules") return launcherCommand(root, platform);
  const pattern = renderControlPlaneRules(launcherToken(root, platform)).split("\n")
    .find((line) => line.trimStart().startsWith("pattern = "));
  if (!pattern) throw new Error("the Control Plane rules renderer wrote no pattern line");
  return pattern.trim();
}

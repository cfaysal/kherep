import path from "node:path";

import { intercomValues } from "../../../bootstrap/render-intercom.mts";
import { controlPlaneRulesPath, launcherRule, renderControlPlaneRules } from "../../../codex/lib/control-plane-rules.mts";

// Issue #436. The five files that must name the stable intercom command, and
// the text doctor expects in each: the always-loaded Claude and Codex
// instructions, the two routing files and the Codex rules allowlist. The
// installers render them through bootstrap/render-intercom.mts and the rules
// renderer; the expected text comes from the same two functions.

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

// The rendered command of this config root; throws for a root no shell can quote.
export function intercomCommand(root: string, platform: NodeJS.Platform = process.platform): string {
  return intercomValues(root, platform).command;
}

// A file is current when it holds this text: the command itself, or for the
// rules file the launcher's whole prefix_rule, pattern and examples, exactly as
// codex/install.mts writes it (without the file header the renderer adds).
export function expectedIntercomText(kind: IntercomInstruction, command: string): string {
  if (kind !== "codexRules") return command;
  const rules = renderControlPlaneRules([launcherRule(command)]);
  return rules.slice(rules.indexOf("prefix_rule("));
}

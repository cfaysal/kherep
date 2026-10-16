// The exact thread/fork request of the Codex fork reply (issue #408, design
// section 3) and the feature filter it depends on. Measured on Codex
// 0.162.0-alpha.17.2 and 0.163.0: deferGoalContinuation cannot be combined
// with ephemeral (-32600) and copies the goal into a persisted fork, so it is
// never sent; goals stay off through features.goals=false and the goal checks
// of codex-fork-process.mts. permissions cannot be combined with sandbox; no
// model, provider, tier or instructions are set.

// The feature keys switched off in a fork, each emitted only when the binary's
// `codex features list` lists it and not as removed.
export const FORK_FEATURE_KEYS = ["shell_tool", "request_permissions_tool", "apps", "plugins", "multi_agent", "multi_agent_v2",
  "code_mode", "browser_use", "computer_use", "image_generation", "tool_suggest", "skill_search", "goals", "view_image", "hooks"] as const;

export function forkParams(owner: string, lastTurnId: string, cwd: string, features: ReadonlySet<string>, mcpNames: readonly string[]) {
  const config: Record<string, unknown> = {};
  for (const key of FORK_FEATURE_KEYS) if (features.has(key)) config[`features.${key}`] = false;
  config.web_search = "disabled";
  config["tools.experimental_request_user_input.enabled"] = false;
  for (const name of mcpNames) config[`mcp_servers.${name}.enabled`] = false;
  return { threadId: owner, lastTurnId, ephemeral: true, excludeTurns: true, cwd, runtimeWorkspaceRoots: [cwd], sandbox: "read-only",
    approvalPolicy: "on-request", config };
}

const FEATURE_LINE = /^(\S+)\s+(stable|experimental|under development|removed)\s+(true|false)\s*$/;

// The keys a `codex features list` output lists as not removed, or null for an
// output with any other non-empty line or with no key at all.
export function parseFeaturesList(stdout: string): Set<string> | null {
  const keys = new Set<string>();
  let rows = 0;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = FEATURE_LINE.exec(line);
    if (!match) return null;
    rows++;
    if (match[2] !== "removed") keys.add(match[1]!);
  }
  return rows ? keys : null;
}

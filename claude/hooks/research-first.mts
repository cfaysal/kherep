#!/usr/bin/env node
/**
 * research-first.mts  -  UserPromptSubmit hook (evidence first, OP-1440)
 *
 * Adds a short research-first instruction to every prompt inside the configured
 * Kherep workspace: classify the prompt, and for a relevant one research before
 * answering - the Central Brain always, the code graph first when the working
 * directory is inside a git repository. research-stop.mts enforces it.
 *
 * No model call, no network, nothing leaves the host. It reads two local facts:
 * whether cwd sits in a git repository, and the space key in
 * <claude-home>/kherep/confluence.json. Neither the prompt nor the payload is
 * echoed. Any error exits silently and never blocks the prompt.
 */
import fs from "node:fs";
import path from "node:path";

import { gitRepositoryOf, type Exists } from "./lib/research-evidence.mts";
import { workspaceForPayload, type EnvLike } from "./lib/workspace-scope.mts";

export interface PromptPayload {
  cwd?: unknown;
  [key: string]: unknown;
}

const DEFAULT_CONFIG = path.join(import.meta.dirname, "..", "kherep", "confluence.json");
const SPACE_KEY = /^[A-Za-z0-9~_-]{1,64}$/;

// The installed space key, or a pointer to where it lives. A key that does not
// look like one is not printed: this file is operator configuration.
export function spaceKeyFrom(configPath: string = DEFAULT_CONFIG): string {
  try {
    const key = (JSON.parse(fs.readFileSync(configPath, "utf8")) as { spaceKey?: unknown }).spaceKey;
    if (typeof key === "string" && SPACE_KEY.test(key)) return key;
  } catch {
    // Absent or unreadable: fall through to the pointer.
  }
  return "<spaceKey from <claude-home>/kherep/confluence.json>";
}

// The same form bootstrap/render-profile-paths.mts renders into the permission
// allowlist (path.resolve, then "/tools/..."), so the suggested command matches
// the allow rule instead of raising a permission prompt.
export function brokerRoot(workspace: string): string {
  return path.resolve(workspace);
}

export function promptContext(
  value: unknown,
  env: EnvLike = process.env,
  configPath: string = DEFAULT_CONFIG,
  exists?: Exists,
): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const payload = value as PromptPayload;
  const workspace = workspaceForPayload(payload, env);
  if (!workspace) return "";

  const lines = [
    "RESEARCH FIRST (ROUTING.md, Evidence first): classify this prompt. A banal one (greeting, acknowledgement, a fact that needs no lookup) is answered directly. For a relevant one, research before answering:",
    `1. Central Brain: node ${brokerRoot(workspace)}/tools/atl-confluence-ccoder.mts search --space ${spaceKeyFrom(configPath)} --query "<terms>". Search terms follow the privacy classification; private content never goes to Atlassian. Exit 2 means unavailable (UNKNOWN), not no match.`,
  ];
  if (gitRepositoryOf(payload.cwd, exists)) {
    lines.push("2. Code graph: the working directory is inside a git repository. If it is indexed by codebase-memory, query the code graph (mcp__codebase-memory-mcp__*) first, before reading files.");
  }
  lines.push("Answer after comparing with the Brain; name the page id of a Brain page your result contradicts. A substantial turn without research ends with [research: none - <reason>].");
  return lines.join("\n");
}

function main(): void {
  try {
    const text = promptContext(JSON.parse(fs.readFileSync(0, "utf8") || "{}"));
    if (!text) return;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text },
    }));
  } catch {
    // Never break the prompt submit.
  }
}

if (import.meta.main) main();

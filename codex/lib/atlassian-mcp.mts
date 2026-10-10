// Issue #376. The managed Codex table for the Atlassian MCP server v2 through
// the Codex service account. It runs the secret-file wrapper (installed as
// orchestra/supergateway-secret-wrapper.mts) with the API key file and the
// endpoint, and keeps executeDestructive behind Codex's own approval prompt.
import { ATLASSIAN_MCP_ENDPOINT, ATLASSIAN_MCP_SERVER } from "../../lib/atlassian-mcp-binding.mts";
import type { PluginMcpServer } from "./contracts.mts";
import { mcpTableRange } from "./managed-config.mts";

export const ATLASSIAN_PROMPT_TOOLS = ["executeDestructive"];

// The table installs up to issue #376 rendered: personal OAuth through Codex's
// native HTTP transport. Kept only so such a block is recognised and replaced.
export const PREDECESSOR_NATIVE_ATLASSIAN: PluginMcpServer = { url: ATLASSIAN_MCP_ENDPOINT };

export interface AtlassianTableTarget { node: string; runtime: string }

export function atlassianMcpServer(tokenFile: string, target: AtlassianTableTarget): PluginMcpServer {
  return {
    command: target.node,
    args: [target.runtime],
    env: { KHEREP_MCP_AUTH_FILE: tokenFile, KHEREP_MCP_ENDPOINT: ATLASSIAN_MCP_ENDPOINT },
    promptTools: ATLASSIAN_PROMPT_TOOLS,
  };
}

function tomlStringValue(literal: string): string | undefined {
  try {
    const parsed = JSON.parse(literal);
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// The token file a managed Atlassian table of an earlier install names, so a
// block written for another path is still known as the installer's own. Only
// the managed block is read; the full fragment must still match exactly.
export function managedAtlassianTokenFile(
  config: string, markers: { start: string; end: string },
): string | undefined {
  const range = mcpTableRange(config, ATLASSIAN_MCP_SERVER);
  const start = config.indexOf(markers.start);
  const end = config.indexOf(markers.end);
  if (!range || start < 0 || end <= start || range.start <= start || range.start >= end) return undefined;
  const env = range.text.match(
    /^env = \{ KHEREP_MCP_AUTH_FILE = ("(?:\\.|[^"\\])*"), KHEREP_MCP_ENDPOINT = ("(?:\\.|[^"\\])*") \}\r?$/m,
  );
  return env ? tomlStringValue(env[1]) : undefined;
}

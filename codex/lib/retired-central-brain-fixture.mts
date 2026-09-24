// Test fixture (OP-1429): turns a current managed block into the block a
// pre-retirement installer wrote for a host with a Central Brain selection.
// Installer tests cannot call the renderer with the installer's own options, so
// they transform the text it wrote. retired-central-brain.test.mts proves the
// transformation equals the historical renderer on synthetic options.
import { nativeCommand } from "./memory-provider.mts";
import { hookGroup, renderMcpServer } from "./parity-config.mts";
import type { RetiredCentralBrainRender } from "./retired-central-brain.mts";

function insertBefore(text: string, anchor: string, addition: string, unique = true): string {
  const index = text.indexOf(anchor);
  if (index < 0 || (unique && text.indexOf(anchor, index + 1) >= 0)) throw new Error(`fixture anchor is missing or not unique: ${anchor}`);
  return text.slice(0, index) + addition + text.slice(index);
}

export function withRetiredCentralBrain(
  block: string, retired: RetiredCentralBrainRender, node: string, pluginNames: readonly string[],
): string {
  const hooks = retired.nativeHooks;
  if (!hooks) throw new Error("fixture needs native hooks");
  const bound = (cli: string) => nativeCommand([node, cli, "codex", "--profile", hooks.profile],
    process.platform, hooks.extraCaCertificates);
  const entry = (event: string, cli: string, timeout: number) =>
    hookGroup(event, "", [{ command: bound(cli), timeout }]).slice(`[[hooks.${event}]]`.length);
  let text = block;
  text = insertBefore(text, "\n\n[[hooks.PostToolUse]]", entry("UserPromptSubmit", hooks.contextCli, 15));
  text = insertBefore(text, "\n\n[[hooks.PreCompact]]", entry("SessionStart", hooks.contextCli, 15));
  text = insertBefore(text, "\n\n[[hooks.SubagentStart]]", entry("Stop", hooks.captureCli, 10));
  const table = `\n\n${renderMcpServer(retired.server, { mcpServers: [] })}`;
  const plugin = pluginNames.map((name) => `\n\n[mcp_servers.${name}]`).find((anchor) => text.includes(anchor));
  text = plugin ? insertBefore(text, plugin, table) : text.trimEnd() + table + text.slice(text.trimEnd().length);
  const sessionEnd = `\n\n${hookGroup("SessionEnd", "other", [{ command: bound(hooks.captureCli), timeout: 3 }])}`;
  return insertBefore(text, "\n\n[mcp_servers.", sessionEnd, false);
}

// The block measured on the Mac: the same render with the MCP table moved out of
// the managed block. Returns the block without it and the table on its own.
export function withoutRetiredTable(block: string, retired: RetiredCentralBrainRender): { block: string; table: string } {
  const table = renderMcpServer(retired.server, { mcpServers: [] });
  const parts = block.split(`\n\n${table}`);
  if (parts.length !== 2) throw new Error("fixture anchor is missing or not unique: central-brain table");
  return { block: parts.join(""), table };
}

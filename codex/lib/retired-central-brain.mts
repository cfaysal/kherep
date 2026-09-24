import { removeExactUnmanagedMcp } from "./managed-config.mts";
import * as parityConfig from "./parity-config.mts";
import type { McpServerSpec } from "./contracts.mts";
import type { CentralBrainBinding } from "./memory-provider.mts";
import type { RenderOptions } from "./parity-config.mts";

// What a pre-retirement installer added to the managed block for a selected
// Central Brain: one stdio MCP table, appended after every registry server, and
// the native hooks. Enough to rebuild that block byte for byte (OP-1429).
export interface RetiredCentralBrainRender {
  server: McpServerSpec;
  nativeHooks?: RenderOptions["nativeHooks"];
}

export function retiredCentralBrainRender(binding: CentralBrainBinding, node: string): RetiredCentralBrainRender {
  return {
    server: { name: "central-brain", transport: "stdio", command: node,
      args: [binding.mcpCli, "codex", "--profile", binding.profile] },
    nativeHooks: binding.nativeHooks ? { ...binding.nativeHooks, profile: binding.profile } : undefined,
  };
}

// Every render the current installer accepts as its own block, for the render
// options it installs now and for those before the observation Stop hook.
export function managedFragmentFamily(current: RenderOptions, previousStop: RenderOptions): string[] {
  return [current, previousStop, { ...current, observationStopHook: true }].flatMap((options) => [
    parityConfig.render(options),
    parityConfig.renderWithoutNativeHooks(options),
    parityConfig.renderPreviousNativeHooks(options),
    parityConfig.renderBeforeObservationHook(options),
    parityConfig.renderBeforeObservationHookWithoutNativeHooks(options),
    parityConfig.renderBeforePostLegacyHooks(options),
    parityConfig.renderBeforePostLegacyHooksWithoutNativeHooks(options),
  ]);
}

// The same family as a host with the retired selection had it on disk. The
// replacement is the current render, so the MCP table and the native hooks go.
export function retiredCentralBrainFragments(
  current: RenderOptions, previousStop: RenderOptions, retired?: RetiredCentralBrainRender,
): string[] {
  if (!retired) return [];
  const selected = (options: RenderOptions, servers: McpServerSpec[]): RenderOptions => ({
    ...options, memoryProvider: "central-brain", nativeHooks: retired.nativeHooks,
    mcpServers: [...options.mcpServers, ...servers],
  });
  // The second variant is the block measured on a Mac: native hooks inside, the
  // MCP table outside (see retireUnmanagedCentralBrainTable).
  return [[retired.server], []].flatMap((servers) =>
    managedFragmentFamily(selected(current, servers), selected(previousStop, servers)));
}

export interface RetiredCentralBrainTable {
  name: string;
  status: "removed" | "retained-for-review";
}

// A retired MCP table outside the managed block goes only when it is exactly the
// table the retired render wrote for the persisted selection: no extra key, no
// subtable, no second copy. Anything else stays and is reported for review. The
// install backup holds the whole original config.toml either way.
export function retireUnmanagedCentralBrainTable(
  config: string, retired: RetiredCentralBrainRender | undefined, startMarker: string, endMarker: string,
): { config: string; tables: RetiredCentralBrainTable[] } {
  if (!retired) return { config, tables: [] };
  const name = retired.server.name;
  const anyTable = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*["']?${name}["']?\\s*[.\\]]`, "m");
  const outside = (text: string) => {
    const start = text.indexOf(startMarker);
    const end = text.indexOf(endMarker);
    return start >= 0 && end > start ? text.slice(0, start) + text.slice(end + endMarker.length) : text;
  };
  if (!anyTable.test(outside(config))) return { config, tables: [] };
  const removal = removeExactUnmanagedMcp(config, name, parityConfig.renderMcpServer(retired.server, { mcpServers: [] }),
    startMarker, endMarker);
  return removal.removed && !anyTable.test(outside(removal.config))
    ? { config: removal.config, tables: [{ name, status: "removed" }] }
    : { config, tables: [{ name, status: "retained-for-review" }] };
}

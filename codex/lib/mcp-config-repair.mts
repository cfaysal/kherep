import path from "node:path";

import type { McpCompatibilityOptions, McpProjection } from "./contracts.mts";
import * as managedConfig from "./managed-config.mts";
import { canonicalizeOwnedRegistryTable, replaceOwnedRegistryTransport } from "./mcp-legacy-repair.mts";
import type { McpRenderOptions } from "./parity-config.mts";

export interface McpConfigRepairOptions extends McpRenderOptions {
  startMarker: string;
  endMarker: string;
  registryProjections: McpProjection[];
  mcpCompatibility?: McpCompatibilityOptions;
}

function namesFor(name: string, compatibility?: McpCompatibilityOptions): string[] {
  return [...new Set([name, ...(compatibility?.legacyServerNames?.[name] || [])])];
}

export function repairManagedMcp(config: string, options: McpConfigRepairOptions) {
  const compatibility = options.mcpCompatibility;
  const retiredBridge = path.join(path.dirname(String(options.registryBridge)), "registry-http-bridge.js");
  const bridges = [String(options.registryBridge), retiredBridge];
  const repaired = new Set<string>();
  let next = config;

  for (const projection of options.registryProjections) {
    const tableNames = namesFor(projection.name, compatibility);
    const sourceNames = [...new Set([
      compatibility?.sourceNames?.[projection.name] ?? projection.name,
      ...tableNames,
      projection.name,
    ])];
    for (const tableName of tableNames) {
      for (const oldPrefix of [...new Set([...(compatibility?.legacyEnvPrefixes || []), "KHEREP_"])]) {
        for (const expectedBridge of bridges) {
          for (const expectedSourceName of sourceNames) {
            const repairOptions = {
              name: tableName, expectedNode: String(options.node), expectedBridge,
              expectedRegistry: String(options.registry), expectedSourceName,
              oldPrefix, newPrefix: "KHEREP_",
              startMarker: options.startMarker, endMarker: options.endMarker,
            };
            const renderableReplacement = projection.transport === "stdio"
              || (projection.transport === "http" && projection.authentication === "native");
            let result;
            if (renderableReplacement) {
              result = replaceOwnedRegistryTransport(next, {
                ...repairOptions, outputName: projection.name, projection,
              });
            } else {
              result = canonicalizeOwnedRegistryTable(next, repairOptions);
            }
            next = result.config;
            if (result.migrated) repaired.add(projection.name);
          }
        }
      }
    }
  }

  const existingManagedMcp = new Set(options.registryProjections
    .filter(({ name }) => namesFor(name, compatibility).some((tableName) => managedConfig.hasUnmanagedMcp(
      next, tableName, options.startMarker, options.endMarker,
    )))
    .map(({ name }) => name));
  const mcpServers = options.registryProjections.filter(({ name, transport }) => (
    (transport === "http" || transport === "stdio") && !existingManagedMcp.has(name)
  ));
  return { config: next, existingManagedMcp, mcpServers, repairedMcpServers: [...repaired] };
}

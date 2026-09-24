import path from "node:path";

import type { McpCompatibilityOptions, McpProjection, McpServerSpec, PluginMcpServer } from "./contracts.mts";
import * as managedConfig from "./managed-config.mts";
import { repairManagedMcp } from "./mcp-config-repair.mts";
import { recoverManagedMcpProjection } from "./mcp-operator-binding.mts";
import * as parityConfig from "./parity-config.mts";
import { recognizeHistoricalManagedConfig } from "./historical-managed-artifacts.mts";
import { configureMemoryNotify } from "./memory-provider.mts";
import { managedFragmentFamily, retiredCentralBrainFragments, retireUnmanagedCentralBrainTable } from "./retired-central-brain.mts";
import type { RetiredCentralBrainRender } from "./retired-central-brain.mts";
import { enableHooks, setMarkedBlock, setTopLevelSetting } from "./text-merge.mts";
import { hasTomlStringReference, rewriteExactTomlStringArgs } from "./toml-args.mts";

export interface ConfigUpgradeOptions {
  startMarker: string;
  endMarker: string;
  knownManagedFragments: string[];
  managedReplacement: string;
  mcpServerNames: string[];
  retiredBridge: string;
  currentBridge: string;
}

export interface ConfigUpgradeResult {
  config: string;
  managedFragment: "created" | "current" | "replaced";
  migratedMcpServers: string[];
}

export interface ManagedConfigOptions {
  memoryProvider?: "unconfigured";
  retiredCentralBrain?: RetiredCentralBrainRender;
  observationStopHook?: boolean;
  startMarker: string;
  endMarker: string;
  retiredMcpServerNames: string[];
  registryProjections: McpProjection[];
  pluginMcpServers: Record<string, PluginMcpServer>;
  contextHook: string;
  hookDir: string;
  node: string;
  registry: string;
  registryBridge: string;
  registryRuntime: string;
  memoryNotifyHook: string;
  mcpCompatibility?: McpCompatibilityOptions;
}

export function replaceExactManagedFragment(
  config: string,
  startMarker: string,
  endMarker: string,
  knownFragments: string[],
  replacement: string,
): string {
  const validated = setMarkedBlock(config, startMarker, endMarker, replacement);
  const start = config.indexOf(startMarker);
  if (start < 0) return validated;
  const bodyStart = start + startMarker.length;
  const bodyEnd = config.indexOf(endMarker, bodyStart);
  const body = config.slice(bodyStart, bodyEnd);
  const next = replacement.trim();
  const currentOffset = body.indexOf(next);
  if (currentOffset >= 0) {
    if (body.indexOf(next, currentOffset + next.length) >= 0) {
      throw new Error("Refusing to replace an ambiguous exact known managed fragment");
    }
    const remainder = body.slice(0, currentOffset) + body.slice(currentOffset + next.length);
    if (/^\s*\[\s*mcp_servers\s*\./m.test(remainder)) {
      throw new Error("Refusing to retain unmatched MCP tables in the managed block");
    }
    return config;
  }

  const candidates = [...knownFragments].map((fragment) => fragment.trim())
    .filter(Boolean).sort((left, right) => right.length - left.length);
  for (const candidate of candidates) {
    const offset = body.indexOf(candidate);
    if (offset < 0) continue;
    if (body.indexOf(candidate, offset + candidate.length) >= 0) {
      throw new Error("Refusing to replace an ambiguous exact known managed fragment");
    }
    const remainder = body.slice(0, offset) + body.slice(offset + candidate.length);
    if (/^\s*\[\s*mcp_servers\s*\./m.test(remainder)) {
      throw new Error("Refusing to retain unmatched MCP tables in the managed block");
    }
    const absolute = bodyStart + offset;
    return config.slice(0, absolute) + next + config.slice(absolute + candidate.length);
  }
  throw new Error("Refusing to overwrite a managed block without an exact known managed fragment");
}

export function migrateExactUnmanagedMcpArg(
  config: string,
  name: string,
  oldArg: string,
  newArg: string,
  startMarker: string,
  endMarker: string,
): { config: string; migrated: boolean } {
  const source = String(config);
  const range = managedConfig.mcpTableRange(source, name);
  if (!range) return { config: source, migrated: false };
  const managedStart = source.indexOf(startMarker);
  const managedEnd = source.indexOf(endMarker);
  if (managedStart >= 0 && managedEnd > managedStart
      && range.start > managedStart && range.start < managedEnd) {
    return { config: source, migrated: false };
  }

  let rewritten;
  try {
    rewritten = rewriteExactTomlStringArgs(range.text, oldArg, newArg);
  } catch {
    throw new Error(`Retired bridge reference for mcp_servers.${name} could not be migrated safely`);
  }
  if (hasTomlStringReference(rewritten.text, oldArg)) {
    throw new Error(`Retired bridge reference for mcp_servers.${name} could not be migrated safely`);
  }
  if (!rewritten.migrated) return { config: source, migrated: false };
  return {
    config: source.slice(0, range.start) + rewritten.text + source.slice(range.end),
    migrated: true,
  };
}

function unmanagedMcpText(config: string, startMarker: string, endMarker: string): string {
  const start = config.indexOf(startMarker);
  const end = config.indexOf(endMarker);
  const unmanaged = start >= 0 && end > start
    ? config.slice(0, start) + config.slice(end + endMarker.length) : config;
  let active = false;
  return unmanaged.split(/(?<=\n)/).filter((line) => {
    if (/^\s*\[/.test(line)) active = /^\s*\[\s*mcp_servers\s*\./.test(line);
    return active;
  }).join("");
}

export function preserveConfigUpgrade(
  config: string,
  options: ConfigUpgradeOptions,
): ConfigUpgradeResult {
  const hadManagedBlock = config.includes(options.startMarker);
  const managedWasCurrent = hadManagedBlock && config
    .slice(config.indexOf(options.startMarker), config.indexOf(options.endMarker))
    .includes(options.managedReplacement.trim());
  const migratedMcpServers: string[] = [];
  let next = config;
  for (const name of new Set(options.mcpServerNames)) {
    const migration = migrateExactUnmanagedMcpArg(
      next, name, options.retiredBridge, options.currentBridge,
      options.startMarker, options.endMarker,
    );
    next = migration.config;
    if (migration.migrated) migratedMcpServers.push(name);
  }
  if (hasTomlStringReference(
    unmanagedMcpText(next, options.startMarker, options.endMarker),
    options.retiredBridge,
  )) {
    throw new Error("Retired bridge reference remains in an unknown unmanaged MCP table");
  }
  next = replaceExactManagedFragment(
    next, options.startMarker, options.endMarker,
    options.knownManagedFragments, options.managedReplacement,
  );
  return {
    config: next,
    managedFragment: !hadManagedBlock ? "created" : managedWasCurrent ? "current" : "replaced",
    migratedMcpServers,
  };
}

export function prepareManagedConfig(config: string, options: ManagedConfigOptions) {
  const retiredMcpServers = options.retiredMcpServerNames.map((name) => ({
    name,
    status: managedConfig.removeMcpTables(config, [name]) !== config ? "removed" : "absent",
  }));
  let migrated = managedConfig.removeMcpTables(config, options.retiredMcpServerNames);
  const recoveredMcpServers = new Set<string>();
  const registryProjections = options.registryProjections.map((projection) => {
    if (projection.transport === "http" || projection.transport === "stdio") return projection;
    const recovered = recoverManagedMcpProjection(
      projection.name, migrated,
      {
        node: options.node, runtime: options.registryRuntime,
        registry: options.registry, registryBridge: options.registryBridge,
      },
      { start: options.startMarker, end: options.endMarker },
    );
    if (recovered) recoveredMcpServers.add(projection.name);
    return recovered ?? projection;
  });
  const effectiveOptions = { ...options, registryProjections };
  const repaired = repairManagedMcp(migrated, { ...effectiveOptions, mcpServers: [] });
  migrated = repaired.config;
  const { existingManagedMcp, mcpServers, repairedMcpServers } = repaired;
  const retiredBridge = path.join(path.dirname(options.registryBridge), "registry-http-bridge.js");
  const pluginMcpServers = Object.fromEntries(Object.entries(options.pluginMcpServers)
    .filter(([name]) => !managedConfig.hasUnmanagedMcp(
      config, name, options.startMarker, options.endMarker,
    )));
  let next = setTopLevelSetting(migrated, "model_reasoning_effort", '"xhigh"');
  next = configureMemoryNotify(next, options.node, options.memoryNotifyHook);
  next = enableHooks(next);
  const retiredTable = retireUnmanagedCentralBrainTable(next, options.retiredCentralBrain, options.startMarker, options.endMarker);
  next = retiredTable.config;
  const currentRenderOptions = { ...effectiveOptions, mcpServers, pluginMcpServers };
  const previousStopOptions = { ...currentRenderOptions, observationStopHook: false };
  const currentLegacyOptions = { ...currentRenderOptions, memoryProvider: "unconfigured" as const };
  const legacyRenderOptions = { ...currentLegacyOptions, observationStopHook: false };
  const predecessorRenderOptions = {
    ...legacyRenderOptions,
    mcpServers: registryProjections.flatMap<McpServerSpec>((projection) => {
      if (projection.transport === "http") {
        return [{
          name: projection.name,
          transport: "http",
          authentication: "registry-bearer",
          sourceName: projection.authentication === "registry-bearer"
            ? projection.sourceName : options.mcpCompatibility?.sourceNames?.[projection.name] ?? projection.name,
        }];
      }
      return projection.transport === "stdio" ? [projection] : [];
    }),
    pluginMcpServers: options.pluginMcpServers,
    registryBridge: retiredBridge,
  };
  const historical = recognizeHistoricalManagedConfig(
    next, currentRenderOptions, legacyRenderOptions, predecessorRenderOptions,
  );
  const upgrade = preserveConfigUpgrade(next, {
    startMarker: options.startMarker,
    endMarker: options.endMarker,
    knownManagedFragments: [
      ...managedFragmentFamily(currentRenderOptions, previousStopOptions),
      ...retiredCentralBrainFragments(currentRenderOptions, previousStopOptions, options.retiredCentralBrain),
      parityConfig.render(currentLegacyOptions),
      parityConfig.render(legacyRenderOptions),
      parityConfig.renderPreviousNudges({ ...predecessorRenderOptions, registryBridge: options.registryBridge }),
      parityConfig.renderPreviousNudgesPrefix({ ...predecessorRenderOptions, registryBridge: options.registryBridge }),
      parityConfig.renderLegacyJavaScript(predecessorRenderOptions),
      parityConfig.renderLegacyJavaScriptPrefix(predecessorRenderOptions),
    ].concat(historical),
    managedReplacement: parityConfig.render(currentRenderOptions),
    mcpServerNames: registryProjections.map(({ name }) => name),
    retiredBridge,
    currentBridge: options.registryBridge,
  });
  return {
    ...upgrade,
    migratedMcpServers: [...new Set([...upgrade.migratedMcpServers, ...repairedMcpServers])],
    repairedMcpServers,
    recoveredMcpServers,
    existingManagedMcp,
    pluginMcpServers,
    retiredMcpServers: [...retiredMcpServers, ...retiredTable.tables],
  };
}

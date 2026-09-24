import { createHash } from "node:crypto";
import path from "node:path";
import * as parityConfig from "./parity-config.mts";
import type { RenderOptions } from "./parity-config.mts";

export interface TrustedHookRoots { node: string; contextHook: string; hookDir: string }
type Family = "baseline" | "previous-nudges" | "javascript";

function encodedArgument(value: string): string {
  return JSON.stringify(value.replace(/"/g, '\\"')).slice(1, -1);
}

// Only installer-owned arguments are normalized; every other artifact byte matters.
export function canonicalHookArtifact(fragment: string, roots: TrustedHookRoots, javascriptContext = false): string {
  if (/@INSTALL_(?:NODE|CONTEXT|HOOKS)@/.test(fragment)) {
    throw new Error("Reserved artifact normalization marker in managed content");
  }
  const replacements: [string, string][] = [
    [encodedArgument(roots.node), "@INSTALL_NODE@"],
    [encodedArgument(javascriptContext ? roots.contextHook.replace(/\.(?:mts|mjs|ts)$/, ".js") : roots.contextHook), "@INSTALL_CONTEXT@"],
    [encodedArgument(path.join(roots.hookDir, "")) + encodedArgument(path.sep), "@INSTALL_HOOKS@/"],
  ];
  let canonical = fragment.trim();
  for (const [argument, marker] of replacements.sort(([a], [b]) => b.length - a.length)) {
    if (argument) canonical = canonical.replaceAll(argument, marker);
  }
  return canonical;
}

// Immutable identities of complete canonical hook artifacts from the preserved source.
// No name-level hashes or configurable acceptance registry are used.
// Preserved 95c8fca renderer SHA256: fbd1c136a835d9c8c3971107e1a5570eff585763a71ddcdb31e1ca4d4e70695d.
const ARTIFACTS: readonly { family: Family; lines: number; sha256: string }[] = Object.freeze([
  { family: "baseline", lines: 129, sha256: "5fc53b0771f128e1a6e2b100b5ecdbaa18feb07c31c2d515d7394d64c82c0cb8" },
  { family: "previous-nudges", lines: 129, sha256: "d4cac69722d9805815db3e2b4f3d8fabb1912d9343e77dcb50707666a6bc1792" },
  { family: "javascript", lines: 129, sha256: "385afbdd697953dc87b6e92296808da605b34a23f715091b6f9060bfcb0d96f9" },
] as const);


export function recognizeHistoricalManagedConfig(
  config: string, current: RenderOptions, unconfigured: RenderOptions, predecessor: RenderOptions,
): string[] {
  const mcpSuffix = (fragment: string): string => {
    const start = fragment.search(/^\[mcp_servers\./m);
    return start < 0 ? "" : fragment.slice(start).trim();
  };
  return historicalManagedFragments(config, current, {
    baseline: [parityConfig.render(unconfigured), parityConfig.render(current)].map(mcpSuffix),
    "previous-nudges": ["", ...([parityConfig.renderPreviousNudges({
      ...predecessor, registryBridge: current.registryBridge,
    })]).map(mcpSuffix)],
    javascript: ["", ...([parityConfig.renderLegacyJavaScript(predecessor)]).map(mcpSuffix)],
  });
}

export function historicalManagedFragments(
  config: string, roots: TrustedHookRoots, suffixes: Record<Family, string[]>,
): string[] {
  const header = "# Managed Kherep Codex Maestro parity projection.";
  const candidates: string[] = [];
  let offset = config.indexOf(header);
  while (offset >= 0) {
    for (const artifact of ARTIFACTS) {
      const prefix = config.slice(offset).split("\n").slice(0, artifact.lines).join("\n");
      if (/@INSTALL_(?:NODE|CONTEXT|HOOKS)@/.test(prefix)) continue;
      const digest = createHash("sha256").update(canonicalHookArtifact(prefix, roots, artifact.family === "javascript")).digest("hex");
      if (digest !== artifact.sha256) continue;
      for (const suffix of suffixes[artifact.family]) {
        const candidate = suffix ? `${prefix}\n\n${suffix.trim()}` : prefix;
        if (config.startsWith(candidate, offset)) candidates.push(candidate);
      }
    }
    offset = config.indexOf(header, offset + header.length);
  }
  return candidates;
}

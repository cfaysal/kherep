import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RegistryFileOptions {
  registryFile?: string;
  claudeRegistryFile?: string;
  homeDir?: string;
  claudeConfigDir?: string;
  platform?: string;
  requiredMcpServers?: string[];
}

export function resolveRegistryFile(options: RegistryFileOptions = {}): string {
  const explicit = options.registryFile || options.claudeRegistryFile;
  if (explicit) return path.resolve(explicit);
  const homeDir = path.resolve(options.homeDir || os.homedir());
  const claudeHome = path.resolve(options.claudeConfigDir || process.env.CLAUDE_CONFIG_DIR
    || path.join(homeDir, ".claude"));
  const macRegistry = path.join(claudeHome, ".mcp.json");
  if ((options.platform || process.platform) === "darwin"
      && fs.statSync(macRegistry, { throwIfNoEntry: false })?.isFile()) {
    const required = options.requiredMcpServers || [];
    const registry = JSON.parse(fs.readFileSync(macRegistry, "utf8")) as { mcpServers?: Record<string, unknown> };
    const configured = new Set(Object.keys(registry.mcpServers || {}));
    if (required.every((name) => configured.has(name))) return macRegistry;
  }
  return path.join(homeDir, ".claude.json");
}

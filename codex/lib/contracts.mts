// Shared shapes of the Codex projection: the parity manifest
// (codex/parity/capabilities.json), the MCP registry projection and the
// receipt the installer writes. Types only. The JavaScript carried these
// implicitly in every module; one declared place keeps them from drifting.

import type { InstallTransaction } from "./install-transaction.mts";

export interface CapabilityPlugin {
  id: string;
  mode: string;
  target?: string;
}

export interface AgentRenderOptions {
  // Name the projected Codex agent gets. Defaults to the source name; set it where a
  // runtime needs its own name for the same definition.
  as?: string;
  // Repo-relative Markdown source for a runtime-specific definition; defaults to
  // claude/agents/<name>.md.
  source?: string;
  model?: string;
  // true: the Codex dispatch guard denies a dispatch of this agent whose model is
  // missing or differs from `model` (codex/hooks/dispatch-contract-guard.mts).
  enforcePin?: boolean;
  reasoning?: string;
  sandbox?: string;
}

export interface PluginMcpServer {
  command?: string;
  args?: string[];
  url?: string;
}

export interface Capabilities {
  canonicalTargetPolicy: { mode: string; scope: string[]; approvalRef: string };
  kherepSkills: { active: string[]; compatibility: string[] };
  commands: string[];
  agents: Record<string, AgentRenderOptions>;
  mcpServers: string[];
  retiredMcpServers?: string[];
  pluginMcpServers?: Record<string, PluginMcpServer>;
  plugins: CapabilityPlugin[];
  // Runtime-gap entries such as preToolUseRuntime carry a `status`; the
  // installer derives degradedCapabilities from every entry declaring "missing".
  [key: string]: unknown;
}

export interface McpCompatibilityOptions {
  sourceNames?: Record<string, string>;
  legacyServerNames?: Record<string, string[]>;
  legacyEnvPrefixes?: string[];
  operatorBindings?: { n8n?: {
    authentication: "secret-file-bearer";
    authFile: string;
    endpoint: string;
    caFile?: string;
    tlsMode?: "legacy-disabled";
  } };
}

// What parity-config renders: a projected registry entry or a legacy shape the
// installer rebuilds for comparison. The transport is validated at render time,
// so the type stays open.
export interface McpServerSpec {
  name: string;
  transport: string;
  authentication?: string;
  url?: string;
  sourceName?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export type McpProjection =
  | { name: string; transport: "missing" | "unsupported-stdio" | "legacy-registry-adapter" }
  | { name: string; transport: "http"; authentication: "native"; url: string }
  | { name: string; transport: "http"; authentication: "registry-bearer"; sourceName: string }
  | { name: string; transport: "stdio"; authentication?: "secret-file-bearer"; command: string; args: string[]; env?: Record<string, string> };

export interface ReceiptEntry {
  name: string;
  source?: string;
  status: string;
}

export interface PluginStatus {
  id: string;
  mode: string;
  target: string | null;
  status: string;
  version?: string;
  contentSha256?: string;
  source?: string;
}

export interface ProjectionReceipt {
  agents: ReceiptEntry[];
  commands: ReceiptEntry[];
  plugins: PluginStatus[];
  skills: ReceiptEntry[];
  removed?: { agents: string[]; skills: string[] };
}

export interface ProjectionContext {
  memoryProvider?: "unconfigured";
  capabilities: Capabilities;
  claudeHome?: string;
  codexHome: string;
  pluginSourceRoot?: string;
  repoRoot: string;
  transaction: InstallTransaction;
}

export interface CanonicalEntry {
  id: string;
  version?: string;
  path: string;
  contentSha256: string;
}

export interface CanonicalSource extends CanonicalEntry {
  root: string;
}

export type RunCodex = (args: string[], options?: { cwd?: string }) => string;

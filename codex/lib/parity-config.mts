import path from "node:path";
import { nativeCommand } from "./memory-provider.mts";

import type { McpServerSpec, PluginMcpServer } from "./contracts.mts";

const CODEBASE_MEMORY_READ_ONLY_TOOLS = Object.freeze([
  "index_status", "list_projects", "search_graph", "search_code",
  "trace_path", "detect_changes", "query_graph", "get_graph_schema",
  "get_code_snippet", "get_architecture",
]);

export interface HookSpec {
  command: string;
  commandWindows?: string;
  timeout?: number;
  status?: string;
}

interface HookOptions {
  status?: string;
  timeout?: number;
}

// Options for the MCP part alone; the hook part needs the full RenderOptions.
export interface McpRenderOptions {
  // "central-brain" is retired (OP-1429). The installer never renders it as the
  // current block; it only reproduces blocks older installers wrote, so the
  // upgrade can recognise and replace them (see retired-central-brain.mts).
  memoryProvider?: "unconfigured" | "central-brain";
  mcpServers: McpServerSpec[];
  pluginMcpServers?: Record<string, PluginMcpServer>;
  node?: string;
  registry?: string;
  registryBridge?: string;
}

export interface RenderOptions extends McpRenderOptions {
  contextHook: string;
  hookDir: string;
  node: string;
  nativeHooks?: { contextCli: string; captureCli: string; profile: string; extraCaCertificates?: string };
  // Legacy renders only: true was the combined macOS Stop hook, false was the
  // separate Windows observation Stop hook. Omitted means quiet observations.
  observationStopHook?: boolean;
}

function tomlString(value: unknown): string {
  return JSON.stringify(String(value));
}

export function command(...parts: unknown[]): string {
  const quote = (value: unknown): string => `"${String(value).replace(/"/g, '\\"')}"`;
  return parts.map(quote).join(" ");
}

export function hookGroup(event: string, matcher: string, hooks: HookSpec[]): string {
  const lines = [`[[hooks.${event}]]`];
  if (matcher) lines.push(`matcher = ${tomlString(matcher)}`);
  for (const hook of hooks) {
    lines.push("", `[[hooks.${event}.hooks]]`, 'type = "command"');
    lines.push(`command = ${tomlString(hook.command)}`);
    if (hook.commandWindows) lines.push(`commandWindows = ${tomlString(hook.commandWindows)}`);
    lines.push(`timeout = ${hook.timeout || 10}`);
    if (hook.status) lines.push(`statusMessage = ${tomlString(hook.status)}`);
  }
  return lines.join("\n");
}

function scriptHook(node: string, hookDir: string, script: string, options: HookOptions = {}): HookSpec {
  return {
    command: command(node, path.join(hookDir, script)),
    status: options.status,
    timeout: options.timeout,
  };
}

function adaptedHook(node: string, hookDir: string, script: string, phase: string, options: HookOptions = {}): HookSpec {
  return {
    command: command(node, path.join(hookDir, "codex-hook-adapter.mts"), path.join(hookDir, script), phase),
    status: options.status,
    timeout: options.timeout,
  };
}

export function renderHooks(options: RenderOptions, previousNative = false): string {
  const { contextHook, hookDir, node } = options;
  const hook = (script: string, extra?: HookOptions): HookSpec => scriptHook(node, hookDir, script, extra);
  const adapted = (script: string, phase: string, extra?: HookOptions): HookSpec => adaptedHook(node, hookDir, script, phase, extra);
  const native = (cli: string | undefined, timeout = 15): HookSpec[] =>
    options.memoryProvider === "central-brain" && options.nativeHooks && cli
      ? [{ command: previousNative ? command(node, cli, "codex", "--profile", options.nativeHooks.profile)
        : nativeCommand([node, cli, "codex", "--profile", options.nativeHooks.profile], process.platform,
          options.nativeHooks.extraCaCertificates), timeout }] : [];
  const groups = [
    hookGroup("PreToolUse", "Read|Grep|Glob|Edit|Write|MultiEdit|apply_patch|Bash|shell_command|exec_command|functions\\.exec", [adapted("codex-privacy-boundary-guard.mts", "pre-privacy")]),
    hookGroup("PreToolUse", "Agent|spawn_agent|Task|Workflow|WebSearch|WebFetch|mcp__.*", [adapted("codex-privacy-boundary-guard.mts", "pre-privacy")]),
    hookGroup("PreToolUse", "Bash|shell_command|exec_command|functions\\.exec", [adapted("commit-guard.js", "pre"), adapted("deploy-guard.js", "pre-no-transcript")]),
    hookGroup("PreToolUse", "Agent|spawn_agent", [hook("codex-dispatch-contract-guard.mts")]),
    hookGroup("PreToolUse", "mcp__playwright__browser_navigate", [hook("playwright-file-guard.js")]),
    hookGroup("UserPromptSubmit", "", [
      {
        command: command(node, contextHook),
        status: "Applying evidence-first routing",
      },
      ...native(options.nativeHooks?.contextCli),
    ]),
    hookGroup("PostToolUse", "Edit|Write|MultiEdit|apply_patch|functions\\.exec", [
      adapted("manifest-watch.mts", "post"),
      adapted("loc-watch.mts", "post"),
      adapted("umlaut-translit-watch.mts", "post"),
      adapted("simplify-nudge.mts", "post"),
    ]),
    hookGroup("SessionStart", "startup|resume|clear|compact", [
      { command: command(node, contextHook), status: "Loading Kherep Maestro" },
      hook("codex-cbm-reminder.mts"),
      // Read-only. Says whether the Confluence write path exists in tools/ yet,
      // and says it once when it appears. It replaces a proposed hourly task:
      // the state changes exactly once, and a session start is the moment the
      // answer can be used.
      hook("codex-confluence-delivery-check.mts"),
      ...native(options.nativeHooks?.contextCli),
    ]),
    hookGroup("PreCompact", "manual|auto", [hook("codex-precompact-checkpoint.mts", { timeout: 30 })]),
    hookGroup("Stop", "", [
      ...(options.observationStopHook === true
        ? [hook("codex-observation-stop.mts", { timeout: 30 })]
        : [
          hook("codex-acceptance-gate.mts", { timeout: 30 }),
          ...(options.observationStopHook === false
            ? [hook("codex-observation-turn-completion.mts", { timeout: 30 })]
            : []),
        ]),
      ...native(options.nativeHooks?.captureCli, 10),
    ]),
    hookGroup("SubagentStart", ".*", [hook("codex-cbm-reminder.mts")]),
  ];
  if (native(options.nativeHooks?.captureCli).length)
    groups.push(hookGroup("SessionEnd", "other", native(options.nativeHooks?.captureCli, 3)));
  return groups.join("\n\n");
}

export function renderMcpServer(server: McpServerSpec, options: McpRenderOptions): string {
  if (server.transport === "http" && server.authentication === "registry-bearer") {
    return renderRegistryMcpServer(server.name, server.sourceName ?? server.name, "KHEREP_", options);
  }
  const lines = [
    `[mcp_servers.${server.name}]`,
    "enabled = true",
    "required = false",
  ];
  if (server.transport === "http" && server.authentication === "native") {
    lines.push(`url = ${tomlString(server.url)}`);
  } else if (server.transport === "stdio") {
    lines.push(`command = ${tomlString(server.command)}`);
    lines.push(`args = [${(server.args ?? []).map(tomlString).join(", ")}]`);
    if (server.env) {
      const env = Object.entries(server.env)
        .map(([key, value]) => `${key} = ${tomlString(value)}`).join(", ");
      lines.push(`env = { ${env} }`);
    }
  } else {
    throw new Error(`Unsupported MCP projection transport: ${server.name}`);
  }
  lines.push("startup_timeout_sec = 30.0", server.name === "central-brain"
    ? "tool_timeout_sec = 135.0" : "tool_timeout_sec = 60.0");
  if (server.name === "codebase-memory-mcp" && server.transport === "stdio") {
    for (const tool of CODEBASE_MEMORY_READ_ONLY_TOOLS) {
      lines.push(
        "",
        `[mcp_servers.${server.name}.tools.${tool}]`,
        'approval_mode = "approve"',
      );
    }
  }
  return lines.join("\n");
}

export function renderRegistryMcpServer(
  tableName: string, sourceName: string, envPrefix: string, options: McpRenderOptions,
): string {
  return [
    `[mcp_servers.${tableName}]`,
    "enabled = true",
    "required = false",
    `command = ${tomlString(options.node)}`,
    `args = [${tomlString(options.registryBridge)}]`,
    `env = { ${envPrefix}MCP_REGISTRY_FILE = ${tomlString(options.registry)}, ${envPrefix}MCP_SERVER_NAME = ${tomlString(sourceName)}, ${envPrefix}MCP_ALLOW_INSECURE_HTTP = "1" }`,
    "startup_timeout_sec = 30.0",
    "tool_timeout_sec = 60.0",
  ].join("\n");
}

export function renderMcp(options: McpRenderOptions): string {
  return options.mcpServers
    .map((server) => renderMcpServer(server, options)).join("\n\n");
}

export function renderPluginMcp(options: McpRenderOptions): string {
  return Object.entries(options.pluginMcpServers || {}).map(([name, server]) => {
    const lines = [
      `[mcp_servers.${name}]`,
      "enabled = true",
      "required = false",
    ];
    if (server.url) lines.push(`url = ${tomlString(server.url)}`);
    else {
      lines.push(`command = ${tomlString(server.command)}`);
      lines.push(`args = [${(server.args || []).map(tomlString).join(", ")}]`);
    }
    lines.push("startup_timeout_sec = 30.0", "tool_timeout_sec = 60.0");
    return lines.join("\n");
  }).join("\n\n");
}

function renderPrefix(options: RenderOptions): string {
  return ["# Managed Kherep Codex Maestro parity projection.", renderHooks(options)].join("\n\n");
}

export function render(options: RenderOptions): string {
  return [renderPrefix(options), renderMcp(options), renderPluginMcp(options), ""].join("\n\n");
}

export function renderWithoutNativeHooks(options: RenderOptions): string {
  return render({ ...options, nativeHooks: undefined });
}
export function renderPreviousNativeHooks(options: RenderOptions): string {
  return ["# Managed Kherep Codex Maestro parity projection.", renderHooks(options, true), renderMcp(options), renderPluginMcp(options), ""].join("\n\n");
}

// Hooks that did not exist in the JavaScript-era projection. An older installer
// never wrote them, so a legacy fragment containing them would not match the
// block actually on disk - and matching that block is the only reason these
// renders exist. Renaming them to .js would not help: the line was never there
// in any spelling.
export const POST_LEGACY_HOOKS = [
  "codex-confluence-delivery-check",
  "codex-observation-turn-completion",
];
const PRE_OBSERVATION_HOOKS = ["codex-observation-turn-completion"];

function withoutHooks(config: string, names: readonly string[]): string {
  return config
    .split("\n\n")
    .filter((block) => !names.some((name) => block.includes(name)))
    .join("\n\n");
}

function withoutPostLegacyHooks(config: string): string {
  return withoutHooks(config, POST_LEGACY_HOOKS);
}

const LEGACY_JAVASCRIPT_HOOKS = [
  "kherep-maestro-context", "codex-hook-adapter", "codex-privacy-boundary-guard",
  "codex-dispatch-contract-guard", "codex-cbm-reminder", "codex-precompact-checkpoint",
  "codex-acceptance-gate",
];

// OP-1138 renamed the four shared Claude nudges to .mts. Every predecessor
// projection on disk names them .js, and a known managed fragment has to
// reproduce what the OLDER installer WROTE - otherwise the block it left behind
// stops being recognised as managed and survives the upgrade unreplaced.
const LEGACY_SHARED_NUDGES = ["manifest-watch", "loc-watch", "umlaut-translit-watch", "simplify-nudge"];

function withLegacySharedNudges(config: string): string {
  let text = config;
  for (const name of LEGACY_SHARED_NUDGES) text = text.replaceAll(`${name}.mts`, `${name}.js`);
  return text;
}

// Recognize the previous Kherep projection whose shared nudges still used .js.
export function renderPreviousNudgesPrefix(options: RenderOptions): string {
  return withLegacySharedNudges(withoutPostLegacyHooks(renderPrefix({ ...options, nativeHooks: undefined })));
}

export function renderPreviousNudges(options: RenderOptions): string {
  return withLegacySharedNudges(withoutPostLegacyHooks(renderWithoutNativeHooks(options)));
}

// The projection as it stood BEFORE the post-legacy hooks existed. An installer
// one version back wrote exactly this block, so the upgrade has to recognise it
// as managed - otherwise it finds a block it cannot attribute and refuses to
// replace it, and the hook it was supposed to add never arrives.
//
// This is the step that was missed when the delivery-check hook was added on
// 2026-09-22: the legacy-era renders were filtered, the immediately previous one
// was not. Adding a hook means adding its name to POST_LEGACY_HOOKS, and these
// two functions then cover it without further thought.
export function renderBeforePostLegacyHooks(options: RenderOptions): string {
  return withoutPostLegacyHooks(render(options));
}

export function renderBeforePostLegacyHooksWithoutNativeHooks(options: RenderOptions): string {
  return withoutPostLegacyHooks(renderWithoutNativeHooks(options));
}

export function renderBeforeObservationHook(options: RenderOptions): string {
  return withoutHooks(render(options), PRE_OBSERVATION_HOOKS);
}

export function renderBeforeObservationHookWithoutNativeHooks(options: RenderOptions): string {
  return withoutHooks(renderWithoutNativeHooks(options), PRE_OBSERVATION_HOOKS);
}

export function renderLegacyJavaScriptPrefix(options: RenderOptions): string {
  let hooks = withoutPostLegacyHooks(withLegacySharedNudges(renderHooks({ ...options, nativeHooks: undefined })));
  for (const name of LEGACY_JAVASCRIPT_HOOKS) {
    hooks = hooks.replaceAll(`${name}.mts`, `${name}.js`);
  }
  return ["# Managed Kherep Codex Maestro parity projection.", hooks].join("\n\n");
}

export function renderLegacyJavaScript(options: RenderOptions): string {
  return [
    renderLegacyJavaScriptPrefix(options),
    renderMcp(options),
    renderPluginMcp(options),
    "",
  ].join("\n\n");
}

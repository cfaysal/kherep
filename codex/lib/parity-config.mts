import path from "node:path";
import { nativeCommand } from "./memory-provider.mts";
import { renderOutboxWritableRoot } from "./outbox-writable-root.mts";

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

export interface MessagingClientRenderOptions {
  enabled: boolean;
  bridge: string;
  intentHook: string;
  configRoot: string;
}

export interface RenderOptions extends McpRenderOptions {
  contextHook: string;
  hookDir: string;
  node: string;
  nativeHooks?: { contextCli: string; captureCli: string; profile: string; extraCaCertificates?: string };
  // The control-plane delivery hook in the checkout (issue #31, step 4). Blocks
  // written before it existed are rendered without it.
  controlPlaneHook?: string;
  // Exact external delivery groups keep ownership; attribution still needs the checkout.
  omitDeliveryHooks?: boolean;
  // Legacy renders only: true was the combined macOS Stop hook, false was the
  // separate Windows observation Stop hook. Omitted means quiet observations.
  observationStopHook?: boolean;
  // Issue #68. false renders the blocks written before every hook carried a
  // commandWindows form, so the upgrade can recognise and replace them.
  windowsHookCommands?: boolean;
  // Issue #72. The Control Plane outbox as a sandbox writable root, rendered
  // only when the operator's config defines no sandbox_workspace_write table.
  outboxWritableRoot?: string;
  messagingClient?: MessagingClientRenderOptions;
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

// Issue #68. Codex on Windows runs a hook as `pwsh -NoProfile -Command <command>`,
// and a command that starts with a quoted path is a PowerShell ParserError. The
// call operator makes the same quoted parts a valid command in pwsh 7 and in
// Windows PowerShell 5.1; macOS and Linux keep running `command`.
function withWindowsCommand(hook: HookSpec): HookSpec {
  return { ...hook, commandWindows: `& ${hook.command}` };
}

const SHELL_MATCHER = "Bash|shell_command|exec_command|functions\\.exec";

// Issue #325, PR-A. The attribution hook lives next to the deliver hook in the
// checkout; the path is spelled with whatever separator the deliver hook uses.
export function attributionHookPath(controlPlaneHook: string): string {
  return controlPlaneHook.replace(/deliver-hook\.mts$/, "attribution-hook.mts");
}

export function renderHooks(options: RenderOptions, previousNative = false): string {
  const { contextHook, hookDir, node } = options;
  const group = (event: string, matcher: string, hooks: HookSpec[]): string =>
    hookGroup(event, matcher, options.windowsHookCommands === false ? hooks : hooks.map(withWindowsCommand));
  const hook = (script: string, extra?: HookOptions): HookSpec => scriptHook(node, hookDir, script, extra);
  const adapted = (script: string, phase: string, extra?: HookOptions): HookSpec => adaptedHook(node, hookDir, script, phase, extra);
  const native = (cli: string | undefined, timeout = 15): HookSpec[] =>
    options.memoryProvider === "central-brain" && options.nativeHooks && cli
      ? [{ command: previousNative ? command(node, cli, "codex", "--profile", options.nativeHooks.profile)
        : nativeCommand([node, cli, "codex", "--profile", options.nativeHooks.profile], process.platform,
          options.nativeHooks.extraCaCertificates), timeout }] : [];
  // Issue #325, PR-A. The attribution hook runs from the checkout beside the
  // deliver hook, directly with --runtime codex: it never blocks, so it needs no
  // adapter. Its PreToolUse phase ends the shell group; its PostToolUse phase is
  // a group of its own after the only other one, which matches no shell tool.
  // Both placements keep every positional trust key rendered before them.
  const attribution: HookSpec[] = options.controlPlaneHook
    ? [{ command: command(node, attributionHookPath(options.controlPlaneHook), "--runtime", "codex") }] : [];
  const groups = [
    group("PreToolUse", "Read|Grep|Glob|Edit|Write|MultiEdit|apply_patch|Bash|shell_command|exec_command|functions\\.exec", [adapted("codex-privacy-boundary-guard.mts", "pre-privacy")]),
    group("PreToolUse", "Agent|spawn_agent|Task|Workflow|WebSearch|WebFetch|mcp__.*", [adapted("codex-privacy-boundary-guard.mts", "pre-privacy")]),
    group("PreToolUse", SHELL_MATCHER, [adapted("commit-guard.mts", "pre"), adapted("deploy-guard.mts", "pre-no-transcript"),
      // Issue #325. Appended last: Codex trust keys are positional.
      adapted("main-checkout-guard.mts", "pre"), ...attribution]),
    group("PreToolUse", "Agent|spawn_agent", [hook("codex-dispatch-contract-guard.mts")]),
    group("PreToolUse", "mcp__playwright__browser_navigate", [hook("playwright-file-guard.mts")]),
    ...(options.messagingClient?.enabled
      ? [group("PreToolUse", "^mcp__kherep_messaging__(sessions|send|inbox|reply|status)$",
        [{ command: command(node, options.messagingClient.intentHook, "--config-root", options.messagingClient.configRoot) }])]
      : []),
    group("UserPromptSubmit", "", [
      {
        command: command(node, contextHook),
        status: "Applying evidence-first routing",
      },
      hook("codex-research-first.mts"),
      ...native(options.nativeHooks?.contextCli),
    ]),
    group("PostToolUse", "Edit|Write|MultiEdit|apply_patch|functions\\.exec", [
      adapted("manifest-watch.mts", "post"),
      adapted("loc-watch.mts", "post"),
      adapted("umlaut-translit-watch.mts", "post"),
      adapted("simplify-nudge.mts", "post"),
    ]),
    ...(attribution.length ? [group("PostToolUse", SHELL_MATCHER, attribution)] : []),
    group("SessionStart", "startup|resume|clear|compact", [
      { command: command(node, contextHook), status: "Loading Kherep Maestro" },
      hook("codex-cbm-reminder.mts"),
      // Read-only. Says whether the Confluence write path exists in tools/ yet,
      // and says it once when it appears. It replaces a proposed hourly task:
      // the state changes exactly once, and a session start is the moment the
      // answer can be used.
      hook("codex-confluence-delivery-check.mts"),
      ...native(options.nativeHooks?.contextCli),
      // Issue #275. LAST in the group, after the optional native hook: Codex trust
      // keys are positional, so every entry before it keeps its index and trust.
      hook("codex-hook-integrity.mts", { timeout: 30 }),
    ]),
    group("PreCompact", "manual|auto", [hook("codex-precompact-checkpoint.mts", { timeout: 30 })]),
    group("Stop", "", [
      hook("codex-research-stop.mts", { timeout: 30 }),
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
    group("SubagentStart", ".*", [hook("codex-cbm-reminder.mts")]),
  ];
  if (options.controlPlaneHook && !options.omitDeliveryHooks) {
    // Runs from the checkout, because it imports the modules next to it.
    const deliver: HookSpec = { command: command(node, options.controlPlaneHook, "--runtime", "codex") };
    groups.push(
      group("SessionStart", "startup|resume|clear|compact", [deliver]),
      group("UserPromptSubmit", "", [deliver]),
      group("Stop", "", [deliver]),
    );
  }
  if (native(options.nativeHooks?.captureCli).length)
    groups.push(group("SessionEnd", "other", native(options.nativeHooks?.captureCli, 3)));
  // Issue #326, PR-B. The last group of the block: Codex trust keys are
  // positional per event, and no earlier group or entry moves.
  groups.push(group("SubagentStop", "codex-obs", [hook("codex-obs-result-check.mts")]));
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

function renderMessagingClient(options: RenderOptions): string {
  const client = options.messagingClient;
  if (!client?.enabled) return "";
  return [
    "[mcp_servers.kherep_messaging]",
    "enabled = true",
    "required = false",
    `command = ${tomlString(options.node)}`,
    `args = [${[client.bridge, "--config-root", client.configRoot].map(tomlString).join(", ")}]`,
    "startup_timeout_sec = 30.0",
    "tool_timeout_sec = 60.0",
  ].join("\n");
}

// The table sits between the header and the hooks, so the block without it is
// not a substring of the block with it, and an upgrade that drops the table
// cannot mistake the block that still has it for current.
function renderPrefix(options: RenderOptions): string {
  const sandbox = options.outboxWritableRoot ? [renderOutboxWritableRoot(options.outboxWritableRoot)] : [];
  return ["# Managed Kherep Codex Maestro parity projection.", ...sandbox, renderHooks(options)].join("\n\n");
}

export function render(options: RenderOptions): string {
  const messaging = renderMessagingClient(options);
  return [renderPrefix(options), renderMcp(options), renderPluginMcp(options), ...(messaging ? [messaging] : []), ""]
    .join("\n\n");
}

// The previous-native, previous-nudges and JavaScript-era renders reproduce
// blocks written before issue #68, so none of them carries a commandWindows form.
function beforeWindowsCommands(options: RenderOptions): RenderOptions {
  return { ...options, windowsHookCommands: false };
}

export function renderWithoutNativeHooks(options: RenderOptions): string {
  return render({ ...options, nativeHooks: undefined });
}
export function renderPreviousNativeHooks(current: RenderOptions): string {
  const options = beforeWindowsCommands(current);
  const hooks = withoutHooks(renderHooks(options, true), [...PRE_RESEARCH_HOOKS, ...PRE_INTEGRITY_HOOKS]);
  return ["# Managed Kherep Codex Maestro parity projection.", hooks, renderMcp(options), renderPluginMcp(options), ""].join("\n\n");
}

// Hooks that did not exist in the JavaScript-era projection. An older installer
// never wrote them, so a legacy fragment containing them would not match the
// block actually on disk - and matching that block is the only reason these
// renders exist. Renaming them to .js would not help: the line was never there
// in any spelling.
export const POST_LEGACY_HOOKS = [
  "codex-confluence-delivery-check",
  "codex-hook-integrity",
  "codex-observation-turn-completion",
  "codex-research-first",
  "codex-research-stop",
  // With its extension: a bare "main-checkout-guard" also matches a checkout
  // directory of that name in the control-plane hook path.
  "main-checkout-guard.mts",
  "attribution-hook.mts",
  "codex-obs-result-check.mts",
];
const PRE_OBSERVATION_HOOKS = ["codex-observation-turn-completion"];
const PRE_RESEARCH_HOOKS = ["codex-research-first", "codex-research-stop"];
// Issue #325. Every render from before a hook predates each hook added after
// it, so each list extends the list of the hook that came next.
const PRE_OBS_RESULT_HOOKS = ["codex-obs-result-check.mts"];
const PRE_ATTRIBUTION_HOOKS = ["attribution-hook.mts", ...PRE_OBS_RESULT_HOOKS];
const PRE_MAIN_CHECKOUT_HOOKS = ["main-checkout-guard.mts", ...PRE_ATTRIBUTION_HOOKS];
const PRE_INTEGRITY_HOOKS = ["codex-hook-integrity", ...PRE_MAIN_CHECKOUT_HOOKS];

// A group whose every entry was removed goes with them: its header block is
// followed by no entry of its own event. No render has an empty group.
function withoutHooks(config: string, names: readonly string[]): string {
  const blocks = config.split("\n\n").filter((block) => !names.some((name) => block.includes(name)));
  return blocks.filter((block, index) => {
    const event = /^\[\[hooks\.(\w+)\]\]/.exec(block)?.[1];
    return !event || blocks[index + 1]?.startsWith(`[[hooks.${event}.hooks]]`);
  }).join("\n\n");
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

function toLegacyJs(config: string, names: readonly string[]): string {
  let text = config;
  for (const name of names) text = text.replaceAll(`${name}.mts`, `${name}.js`);
  return text;
}

// Issue #237. The three shared Claude guards became .mts after the nudges, so
// every block written before that names them .js: the predecessor renders above
// and every render of the current family as an earlier installer wrote it.
const LEGACY_SHARED_GUARDS = ["commit-guard", "deploy-guard", "playwright-file-guard"];

function withLegacySharedNudges(config: string): string {
  return toLegacyJs(config, [...LEGACY_SHARED_GUARDS, ...LEGACY_SHARED_NUDGES]);
}

export function withLegacySharedGuards(config: string): string {
  return toLegacyJs(config, LEGACY_SHARED_GUARDS);
}

// Recognize the previous Kherep projection whose shared nudges still used .js.
export function renderPreviousNudgesPrefix(options: RenderOptions): string {
  return withLegacySharedNudges(withoutPostLegacyHooks(renderPrefix({ ...beforeWindowsCommands(options), nativeHooks: undefined })));
}

export function renderPreviousNudges(options: RenderOptions): string {
  return withLegacySharedNudges(withoutPostLegacyHooks(renderWithoutNativeHooks(beforeWindowsCommands(options))));
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
  return withoutHooks(render(options), [...PRE_OBSERVATION_HOOKS, ...PRE_RESEARCH_HOOKS, ...PRE_INTEGRITY_HOOKS]);
}

export function renderBeforeObservationHookWithoutNativeHooks(options: RenderOptions): string {
  return withoutHooks(renderWithoutNativeHooks(options), [...PRE_OBSERVATION_HOOKS, ...PRE_RESEARCH_HOOKS, ...PRE_INTEGRITY_HOOKS]);
}

export function renderBeforeResearchHooks(options: RenderOptions): string {
  return withoutHooks(render(options), [...PRE_RESEARCH_HOOKS, ...PRE_INTEGRITY_HOOKS]);
}

export function renderBeforeResearchHooksWithoutNativeHooks(options: RenderOptions): string {
  return withoutHooks(renderWithoutNativeHooks(options), [...PRE_RESEARCH_HOOKS, ...PRE_INTEGRITY_HOOKS]);
}

// Issue #275. The projection immediately before the Codex hook-integrity hook.
export function renderBeforeHookIntegrity(options: RenderOptions): string {
  return withoutHooks(render(options), PRE_INTEGRITY_HOOKS);
}

export function renderBeforeHookIntegrityWithoutNativeHooks(options: RenderOptions): string {
  return withoutHooks(renderWithoutNativeHooks(options), PRE_INTEGRITY_HOOKS);
}

// Issue #325. The projection immediately before the main-checkout guard.
export function renderBeforeMainCheckoutGuard(options: RenderOptions): string {
  return withoutHooks(render(options), PRE_MAIN_CHECKOUT_HOOKS);
}

export function renderBeforeMainCheckoutGuardWithoutNativeHooks(options: RenderOptions): string {
  return withoutHooks(renderWithoutNativeHooks(options), PRE_MAIN_CHECKOUT_HOOKS);
}

// Issue #325, PR-A. The projection immediately before the attribution hook.
export function renderBeforeAttributionHook(options: RenderOptions): string {
  return withoutHooks(render(options), PRE_ATTRIBUTION_HOOKS);
}

export function renderBeforeAttributionHookWithoutNativeHooks(options: RenderOptions): string {
  return withoutHooks(renderWithoutNativeHooks(options), PRE_ATTRIBUTION_HOOKS);
}

// Issue #326, PR-B. The projection immediately before the obs-result check.
export function renderBeforeObsResultCheck(options: RenderOptions): string {
  return withoutHooks(render(options), PRE_OBS_RESULT_HOOKS);
}

export function renderBeforeObsResultCheckWithoutNativeHooks(options: RenderOptions): string {
  return withoutHooks(renderWithoutNativeHooks(options), PRE_OBS_RESULT_HOOKS);
}

export function renderLegacyJavaScriptPrefix(options: RenderOptions): string {
  let hooks = withoutPostLegacyHooks(withLegacySharedNudges(renderHooks({ ...beforeWindowsCommands(options), nativeHooks: undefined })));
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

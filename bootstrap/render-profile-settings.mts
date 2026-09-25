// Settings merge for bootstrap/install.sh: the repo-managed source settings win,
// host-only preferences, hooks, marketplaces and enabled plugins of the existing
// file remain in place. Split out of render-profile.mts for the 250-LOC ceiling
// (Golden Rule 6, OP-1121).

import os from "node:os";

import { isMacIncompatiblePermission, isMacPosixDirectory } from "./render-profile-paths.mts";

export interface HookCommand {
  type?: string;
  command?: string;
  [key: string]: unknown;
}

export interface HookEntry {
  matcher?: string;
  hooks?: HookCommand[];
  [key: string]: unknown;
}

export interface Permissions {
  allow?: string[];
  additionalDirectories?: string[];
  [key: string]: unknown;
}

// A Claude settings.json / settings.local.json. Only the merged keys are typed;
// everything else is carried through by the spread in mergeSettings.
export interface Settings {
  env?: Record<string, string>;
  permissions?: Permissions;
  hooks?: Record<string, HookEntry[]>;
  enabledPlugins?: Record<string, boolean>;
  extraKnownMarketplaces?: Record<string, unknown>;
  allowedTools?: string[];
  [key: string]: unknown;
}

export function unique<T>(values: T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = typeof value === "string" ? value : JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function filterMacPermissions(settings: Settings): void {
  if (!settings.permissions) return;
  if (Array.isArray(settings.permissions.allow)) {
    settings.permissions.allow = settings.permissions.allow.filter((item) => !isMacIncompatiblePermission(item));
  }
  if (Array.isArray(settings.permissions.additionalDirectories)) {
    settings.permissions.additionalDirectories = settings.permissions.additionalDirectories.filter(isMacPosixDirectory);
  }
}

export function isManagedDisallowedPermission(value: unknown): boolean {
  if (value === "mcp__n8n-mcp__n8n_list_workflows") return true;
  return typeof value === "string"
    && /^Bash\(/i.test(value)
    && /\b(?:curl|wget|invoke-webrequest|invoke-restmethod)\b/i.test(value)
    && /(?:^|[^0-9])(?:8000|1234)(?=$|[^0-9])/.test(value);
}

// Issue #13. Workspace-tool rules used to render with a native Windows path,
// Bash(node D:\ws/tools/x.mts verb:*). Git Bash consumes those backslashes, so
// the command they allowed never ran; the managed rule now uses forward
// slashes. A rule whose forward-slash twin is in the same list is that obsolete
// form and is dropped, so an upgrade does not grow the allowlist.
function isObsoleteBackslashToolRule(value: string, allow: ReadonlySet<string>): boolean {
  if (!value.startsWith("Bash(node ") || !value.includes("\\")) return false;
  const slashed = value.replace(/\\/g, "/");
  return slashed.includes("/tools/") && allow.has(slashed);
}

export function filterManagedDisallowedPermissions(settings: Settings): void {
  if (!settings.permissions || !Array.isArray(settings.permissions.allow)) return;
  const allow = new Set(settings.permissions.allow);
  settings.permissions.allow = settings.permissions.allow.filter((item) =>
    !isManagedDisallowedPermission(item) && !isObsoleteBackslashToolRule(item, allow));
}


// Hook commands reach settings.json in several spellings of one path: "~/.claude/x",
// "$HOME/.claude/x", "${HOME}/.claude/x", "%USERPROFILE%\\.claude\\x" or the
// machine-absolute home. They are one hook. Compare them in one portable form so a
// preserved live variant never survives next to the managed entry.
// GRUND: 2026-09-07 trug ~/.claude/settings.json 12 Hooks doppelt, jeder lief pro
// Event zweimal (OP-1130). unique() verglich den rohen JSON-String.
//
// Dieselbe Datei traegt waehrend der Migration zwei Endungen: der verwaltete
// Hook heisst x.mts, die bewahrte Live-Zeile noch x.js. Ohne Faltung waeren das
// zwei Identitaeten, mergeHooks behielte beide, und jeder umbenannte Hook liefe
// zweimal - einmal gegen eine Datei, die das Repo nicht mehr ausliefert.
// Kanonische Schreibweise ist .js. Gefaltet wird nur am Token-Ende und nur das
// erste Vorkommen, also das Skript selbst: ein Argument mit derselben Endung ist
// ein zweiter Pfad, keine zweite Identitaet, und bleibt unveraendert (OP-1136).
const SCRIPT_EXTENSION = /\.(?:mjs|cjs|mts)(?=$|\s)/;

export function normalizeHookCommand(command: string, home: string = os.homedir()): string {
  let result = command.replace(/\\/g, "/").replace(/\$\{HOME\}|\$HOME|%USERPROFILE%/g, "~");
  const homeSlashes = home.replace(/\\/g, "/").replace(/\/+$/, "");
  if (homeSlashes) {
    const escaped = homeSlashes.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escaped, process.platform === "win32" ? "gi" : "g"), "~");
  }
  result = result.replace(
    /(\bnode\s+)["'](~\/\.claude\/hooks\/[^"']+\.(?:js|mjs|cjs|mts))["'](?=$|\s)/,
    "$1$2",
  );
  return result.replace(SCRIPT_EXTENSION, ".js");
}

export function hookIdentity(hook: HookCommand): string {
  const { command, ...rest } = hook;
  const shape = { ...rest, command: typeof command === "string" ? normalizeHookCommand(command) : command };
  return JSON.stringify(Object.entries(shape).sort(([a], [b]) => a.localeCompare(b)));
}

export function uniqueHooks(hooks: HookCommand[]): HookCommand[] {
  const seen = new Set<string>();
  return hooks.filter((hook) => {
    const key = hookIdentity(hook);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function hookKey(item: HookEntry | undefined): string {
  return String((item && item.matcher) || "");
}

// The script a control-plane hook runs, without its arguments; undefined for
// any other hook. Issue #31: the managed wake entry carries its timeout both as
// field and as --timeout argument, so an upgrade that changes the number
// yields another identity. A managed control-plane script therefore replaces
// every existing entry of the same event that runs that script; other hooks
// keep the identity comparison above.
function controlPlaneScript(hook: HookCommand): string | undefined {
  if (typeof hook.command !== "string") return undefined;
  const match = /^node\s+(?:"([^"]+)"|(\S+))/.exec(normalizeHookCommand(hook.command));
  const script = match?.[1] ?? match?.[2];
  return script?.includes("/modules/control-plane/node/") ? script : undefined;
}

function withoutReplacedScripts(entry: HookEntry, scripts: ReadonlySet<string>): HookEntry {
  const hooks = entry.hooks;
  if (!Array.isArray(hooks) || scripts.size === 0) return entry;
  return { ...entry, hooks: hooks.filter((hook) => !scripts.has(controlPlaneScript(hook) ?? "")) };
}

export function mergeHooks(source: Record<string, HookEntry[]> = {}, existing: Record<string, HookEntry[]> = {}): Record<string, HookEntry[]> {
  const result: Record<string, HookEntry[]> = {};
  for (const event of new Set([...Object.keys(existing), ...Object.keys(source)])) {
    const managed: HookEntry[] = (Array.isArray(source[event]) ? source[event] : [])
      .map((entry) => ({ ...entry, hooks: uniqueHooks([...(entry.hooks || [])]) }));
    const replaced = new Set(managed.flatMap((entry) => (entry.hooks || []).map(controlPlaneScript))
      .filter((script): script is string => script !== undefined));
    for (const existingEntry of (Array.isArray(existing[event]) ? existing[event] : [])) {
      const oldEntry = withoutReplacedScripts(existingEntry, replaced);
      // A group that held nothing but replaced entries goes with them.
      const emptied = oldEntry.hooks?.length === 0 && (existingEntry.hooks?.length ?? 0) > 0;
      const index = managed.findIndex((entry) => hookKey(entry) === hookKey(oldEntry));
      if (index < 0) {
        if (!emptied) managed.push(oldEntry);
      } else managed[index] = {
        ...oldEntry,
        ...managed[index],
        hooks: uniqueHooks([...(managed[index].hooks || []), ...(oldEntry.hooks || [])]),
      };
    }
    result[event] = managed;
  }
  return result;
}

export function mergeSettings(source: Settings, existing: Settings): Settings {
  const result: Settings = { ...existing, ...source };
  result.env = { ...(existing.env || {}), ...(source.env || {}) };
  if (source.permissions || existing.permissions) {
    result.permissions = { ...(existing.permissions || {}), ...(source.permissions || {}) };
    if (source.permissions?.allow || existing.permissions?.allow) {
      result.permissions.allow = unique([
        ...(source.permissions?.allow || []),
        ...(existing.permissions?.allow || []),
      ]);
    }
    if (source.permissions?.additionalDirectories || existing.permissions?.additionalDirectories) {
      result.permissions.additionalDirectories = unique([
        ...(source.permissions?.additionalDirectories || []),
        ...(existing.permissions?.additionalDirectories || []),
      ]);
    }
  }
  result.hooks = mergeHooks(source.hooks, existing.hooks);
  if (source.enabledPlugins || existing.enabledPlugins) {
    result.enabledPlugins = { ...(existing.enabledPlugins || {}), ...(source.enabledPlugins || {}) };
  }
  if (source.extraKnownMarketplaces || existing.extraKnownMarketplaces) {
    result.extraKnownMarketplaces = {
      ...(existing.extraKnownMarketplaces || {}), ...(source.extraKnownMarketplaces || {}),
    };
  }
  if (source.allowedTools || existing.allowedTools) {
    result.allowedTools = unique([...(source.allowedTools || []), ...(existing.allowedTools || [])]);
  }
  return result;
}

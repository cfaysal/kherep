#!/usr/bin/env node
// Hook commands that run a retired or missing Claude-home script (issue #252).
//
// A host can carry a second, legacy wiring of its hooks in groups of their own:
// `node ~/.claude/hooks/<name>.js`. mergeSettings keeps every host hook it does
// not manage, so once retired.txt parks such a file the command stays wired and
// fails with "Cannot find module" on every event. The settings render takes
// these commands out of the existing settings before the merge; drift-check.sh
// reports any wired command whose Claude-home script is retired or missing.
//
// Only commands whose first token is `node` followed directly by the script are
// recognised, and only that script counts: a command that names a retired file
// as an argument runs another script and stays. `node <flags> script`,
// `ENV=x node script`, `node.exe`, a quoted node path and `$CLAUDE_CONFIG_DIR`
// forms are not matched, so they are neither unwired nor reported.
// The Claude home is its absolute path in drive (C:\ or C:/) or Git Bash (/c/)
// form. `~/.claude`, `$HOME/.claude`, `${HOME}/.claude` and
// `%USERPROFILE%/.claude` count only while the Claude home is the default
// `<HOME>/.claude`; with another CLAUDE_HOME they name a different directory.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { toBashPath } from "./render-profile-paths.mts";
import type { HookEntry, Settings } from "./render-profile-settings.mts";
import { errorMessage } from "./shape.mts";

const RETIRED_MANIFEST = path.join(import.meta.dirname, "manifest", "retired.txt");
const HOME_TOKENS = ["~/.claude/", "$HOME/.claude/", "${HOME}/.claude/", "%USERPROFILE%/.claude/"];
// The home `~` and `$HOME` expand to in the shell that runs the hook.
const userHomeNow = (): string => process.env.HOME || os.homedir();

export interface HookFinding { event: string; command: string; }

// Claude-home entries of retired.txt. install-retired.sh validates the manifest
// before anything moves; a project/ entry names a workspace file, not a hook.
export function readRetiredHomeEntries(file: string = RETIRED_MANIFEST): Set<string> {
  return new Set(fs.readFileSync(file, "utf8").split(/\r?\n/)
    .map((line) => line.split(" ")[0])
    .filter((entry) => entry && !entry.startsWith("#") && !entry.startsWith("project/")));
}

// One comparable form of a path: forward slashes and the Git Bash drive form
// (C:/x and /c/x have the same length), lowercased when it is a drive path.
function comparable(value: string): string {
  const bash = toBashPath(value);
  return /^\/[A-Za-z](?:\/|$)/.test(bash) ? bash.toLowerCase() : bash;
}

const absoluteHome = (claudeHome: string): string => `${comparable(claudeHome).replace(/\/+$/, "")}/`;

function homePrefixes(claudeHome: string, userHome: string): string[] {
  const home = absoluteHome(claudeHome);
  const isDefault = home === `${comparable(userHome).replace(/\/+$/, "")}/.claude/`;
  return isDefault ? [home, ...HOME_TOKENS] : [home];
}

// The script a `node <script>` command runs relative to the first matching
// prefix, or undefined. An unquoted script ends at whitespace or a shell operator.
function scriptUnder(command: unknown, prefixes: string[]): string | undefined {
  if (typeof command !== "string") return undefined;
  const match = /^\s*node\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|<>]+))/.exec(command);
  const script = (match?.[1] ?? match?.[2] ?? match?.[3])?.replace(/\\/g, "/");
  if (!script) return undefined;
  for (const prefix of prefixes) {
    if (comparable(script.slice(0, prefix.length)) !== prefix) continue;
    const rel = path.posix.normalize(script.slice(prefix.length));
    return rel === "." || rel === ".." || rel.startsWith("../") ? undefined : rel;
  }
  return undefined;
}

// The script a `node <script>` command runs, relative to the Claude home, or
// undefined when the command runs something else or a script outside it.
export function claudeHomeScript(
  command: unknown, claudeHome: string, userHome: string = userHomeNow(),
): string | undefined {
  return scriptUnder(command, homePrefixes(claudeHome, userHome));
}

// Removes every hook command the predicate selects, from any event and group.
// A group left without hooks goes with them; everything else stays as written.
function removeHooks(
  existing: Settings, select: (event: string, command: unknown) => boolean,
): { settings: Settings; removed: HookFinding[] } {
  const removed: HookFinding[] = [];
  if (!existing.hooks || typeof existing.hooks !== "object") return { settings: existing, removed };
  const hooks: Record<string, HookEntry[]> = {};
  for (const [event, entries] of Object.entries(existing.hooks)) {
    if (!Array.isArray(entries)) { hooks[event] = entries; continue; }
    hooks[event] = entries.flatMap((entry) => {
      if (!entry || !Array.isArray(entry.hooks)) return [entry];
      const remaining = entry.hooks.filter((hook) => {
        if (!select(event, hook?.command)) return true;
        removed.push({ event, command: String(hook.command) });
        return false;
      });
      if (remaining.length === entry.hooks.length) return [entry];
      return remaining.length ? [{ ...entry, hooks: remaining }] : [];
    });
  }
  return removed.length ? { settings: { ...existing, hooks }, removed } : { settings: existing, removed };
}

// Removes every command that runs a retired script.
export function retireHookCommands(
  existing: Settings, retired: ReadonlySet<string>, claudeHome: string, userHome: string = userHomeNow(),
): { settings: Settings; removed: HookFinding[] } {
  return removeHooks(existing, (_event, command) => {
    const rel = claudeHomeScript(command, claudeHome, userHome);
    return rel !== undefined && retired.has(rel);
  });
}

const scriptStem = (rel: string): string => rel.replace(/\.(?:js|mjs|cjs|mts)$/, "");

// Review of #254. The template decides at which events a managed hook runs, but
// mergeHooks keeps every existing hook, so an entry the installer wrote at an
// event the template has since dropped would run on. Such an entry (the hook
// under the absolute Claude home, .js and .mts folded) is removed; a hand-written
// ~/.claude form and every hook the template does not manage stay.
export function unwireMovedHooks(
  existing: Settings, source: Settings, claudeHome: string,
): { settings: Settings; removed: Array<HookFinding & { managedAt: string[] }> } {
  const prefixes = [absoluteHome(claudeHome)];
  const managed = new Map<string, Set<string>>();
  for (const [event, entries] of Object.entries(source.hooks || {})) {
    for (const hook of (Array.isArray(entries) ? entries : []).flatMap((entry) => entry?.hooks || [])) {
      const rel = scriptUnder(hook?.command, prefixes);
      if (rel !== undefined) managed.set(scriptStem(rel), (managed.get(scriptStem(rel)) || new Set()).add(event));
    }
  }
  const eventsOf = (command: unknown): Set<string> | undefined => {
    const rel = scriptUnder(command, prefixes);
    return rel === undefined ? undefined : managed.get(scriptStem(rel));
  };
  const result = removeHooks(existing, (event, command) => {
    const events = eventsOf(command);
    return events !== undefined && !events.has(event);
  });
  return {
    settings: result.settings,
    removed: result.removed.map((item) => ({ ...item, managedAt: [...(eventsOf(item.command) || [])] })),
  };
}

// Wired commands whose Claude-home script is retired or does not exist.
export function danglingHookCommands(
  settings: Settings, retired: ReadonlySet<string>, claudeHome: string, userHome: string = userHomeNow(),
  exists: (file: string) => boolean = fs.existsSync,
): HookFinding[] {
  const found: HookFinding[] = [];
  for (const [event, entries] of Object.entries(settings.hooks || {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      for (const hook of (Array.isArray(entry?.hooks) ? entry.hooks : [])) {
        const rel = claudeHomeScript(hook?.command, claudeHome, userHome);
        if (rel === undefined) continue;
        if (retired.has(rel) || !exists(path.join(claudeHome, rel))) found.push({ event, command: String(hook.command) });
      }
    }
  }
  return found;
}

// drift-check.sh: `dangling <settings.json> <claude-home>` prints one
// DANGLING-HOOK line per finding; exit 0 clean, 3 findings, 1 error.
function main(argv: string[]): number {
  const [mode, file, claudeHome] = argv;
  if (mode !== "dangling" || !file || !claudeHome) throw new Error("usage: dangling <settings.json> <claude-home>");
  if (!fs.existsSync(file)) return 0;
  const settings = JSON.parse(fs.readFileSync(file, "utf8")) as Settings;
  const found = danglingHookCommands(settings, readRetiredHomeEntries(), claudeHome);
  for (const item of found) console.log(`DANGLING-HOOK ${item.event} ${item.command}`);
  return found.length ? 3 : 0;
}

// Node loads the main module from its real path, so a script started through a
// symlinked directory (macOS /var -> /private/var) matches only after realpath;
// under --preserve-symlinks-main it keeps the path as given, so both count.
// It needs no main flag on import.meta, which Node 23 and 24.0-24.1 lack.
function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href
      || import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(`FATAL: hook check failed: ${errorMessage(error)}`); process.exitCode = 1; }
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Check } from "./doctor-local.mts";
import { captureSourceIdentity, compareSourceIdentity, type SourceIdentity } from "./daemon-source.mts";

// The hook check of `kherep-node doctor` (issue #215): whether the delivery
// and wake hook commands in Claude settings.json and Codex config.toml name
// this checkout. Only hook command fields are read, never permissions or other
// settings, and only the matched script path is reported.

const HOOK = String.raw`[\\/](?:deliver|wake)-hook\.mts`;
const START = String.raw`(?:[A-Za-z]:[\\/]|[\\/]|~[\\/])`;
// A quoted path may hold spaces; an unquoted one ends at whitespace and must
// start a word, so a command prefix or an inline VAR=value never joins it.
const HOOK_PATH = new RegExp(String.raw`(["'])(${START}[^"'\n]*?${HOOK})\1|(?:^|[\s=])(${START}[^\s"']*?${HOOK})(?=$|[\s;&|])`, "g");

export function hookPaths(command: string): string[] {
  return [...command.matchAll(HOOK_PATH)].map((match) => match[2] ?? match[3]);
}

// Claude settings: hooks.<event>[].hooks[].command.
function claudeCommands(text: string): string[] {
  const hooks = (JSON.parse(text) as { hooks?: unknown }).hooks;
  if (typeof hooks !== "object" || hooks === null) return [];
  return Object.values(hooks).flat().flatMap((group: unknown) => {
    const list = (group as { hooks?: unknown } | null)?.hooks;
    return Array.isArray(list) ? list.map((hook: { command?: unknown } | null) => hook?.command) : [];
  }).filter((command): command is string => typeof command === "string");
}

// Codex config: command and commandWindows keys inside [hooks.*] or
// [[hooks.*]] tables, as TOML basic strings (JSON-compatible escapes); with
// event, only those of that event's tables.
function codexCommands(text: string, event?: string): string[] {
  const commands: string[] = [];
  const table = event ? new RegExp(`^hooks\\.${event}(?:\\.|$)`) : /^hooks\./;
  let inHooks = false;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*$/.exec(line);
    if (header) { inHooks = table.test(header[1]); continue; }
    const entry = inHooks ? /^\s*command(?:Windows)?\s*=\s*("(?:[^"\\]|\\.)*")\s*$/.exec(line) : null;
    if (!entry) continue;
    try { commands.push(JSON.parse(entry[1]) as string); } catch { /* not a JSON-compatible string */ }
  }
  return commands;
}

function expand(file: string): string {
  return /^~[\\/]/.test(file) ? path.join(os.homedir(), file.slice(2)) : file;
}

function realOrResolved(file: string): string {
  const expanded = expand(file);
  try { return fs.realpathSync.native(expanded); } catch { return path.resolve(expanded); }
}

type HookScan = { present: boolean; deliver: number; wake: number; foreign: string[]; pinned?: string[]; checkouts?: string[] };

// The scan as reported, and the reason of its first foreign hook (not reported in the scan).
function scanHooks(
  file: string, repoRoot: string, commandsOf: (text: string) => string[], cache: SourceCache,
): { scan: HookScan; reason?: string } | null {
  let commands: string[];
  try {
    commands = commandsOf(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { scan: { present: false, deliver: 0, wake: 0, foreign: [] } };
    return null;
  }
  const counts = { deliver: 0, wake: 0 };
  const foreign = new Set<string>();
  const pinned = new Set<string>();
  const checkouts = new Set<string>();
  let reason: string | undefined;
  for (const found of commands.flatMap(hookPaths)) {
    const kind = /deliver-hook\.mts$/.test(found) ? "deliver" : "wake";
    const expected = path.join(repoRoot, "modules", "control-plane", "node", `${kind}-hook.mts`);
    if (realOrResolved(found) === realOrResolved(expected)) { counts[kind]++; continue; }
    const same = sameSource(found, kind, cache);
    if ("reason" in same) { foreign.add(found); reason ??= same.reason; continue; }
    counts[kind]++;
    (same.kind === "pin" ? pinned : checkouts).add(found);
  }
  const scan = { present: true, ...counts, foreign: [...foreign], ...(pinned.size ? { pinned: [...pinned] } : {}),
    ...(checkouts.size ? { checkouts: [...checkouts] } : {}) };
  return reason ? { scan, reason } : { scan };
}

const UNVERIFIED = "no verified source identity";

// Issue #445, symmetric to #397: the hook file is the hook of a source root (a
// complete verified source pin under source-pins/, or a clean checkout) whose
// identity, commit and tree, matches the invoking source. A directory name
// alone is never source evidence. Any failure refuses, with its reason.
function sameSource(found: string, kind: "deliver" | "wake", cache: SourceCache): { kind: "pin" | "checkout" } | { reason: string } {
  try {
    const hook = fs.realpathSync.native(expand(found));
    if (!fs.statSync(hook).isFile()) return { reason: UNVERIFIED };
    const root = path.resolve(path.dirname(hook), "..", "..", "..");
    if (hook !== path.join(root, "modules", "control-plane", "node", `${kind}-hook.mts`)) return { reason: UNVERIFIED };
    const actual = cache.of(root);
    if (!actual || (actual.kind === "pin" && path.basename(path.dirname(root)) !== "source-pins")) return { reason: UNVERIFIED };
    const invoking = cache.invoking();
    if (!invoking) return { reason: UNVERIFIED };
    if (!invoking.verified) return { reason: "the invoking source has tracked changes" };
    if (!actual.verified) return { reason: "the hook's source has tracked changes" };
    const compared = compareSourceIdentity(invoking, actual);
    if (compared.status === "match") return { kind: actual.kind };
    if (compared.status === "mismatch") return { reason: compared.reason === "commit" ? "commit differs" : "source tree differs" };
    return { reason: UNVERIFIED };
  } catch { return { reason: UNVERIFIED }; }
}

type SourceCache = { invoking: () => SourceIdentity | undefined; of: (root: string) => SourceIdentity | undefined };

// Source identities of one run, read at most once per real root and only when
// a hook names another root; a failed read stays undefined for the run. A
// dirty checkout yields verified: false rather than an error.
export function sourceCache(repoRoot: string): SourceCache {
  const known = new Map<string, SourceIdentity | undefined>();
  const of = (root: string): SourceIdentity | undefined => {
    const key = realOrResolved(root);
    if (!known.has(key)) {
      let identity: SourceIdentity | undefined;
      try { identity = captureSourceIdentity(key, false); } catch { identity = undefined; }
      known.set(key, identity);
    }
    return known.get(key);
  };
  return { invoking: () => of(repoRoot), of };
}

// ok: at least one hook is installed and every hook command names this source,
// or a source pin or checkout of the same identity.
export function checkHooks(files: { claude: string; codex: string }, repoRoot: string): Check {
  const cache = sourceCache(repoRoot);
  const claude = scanHooks(files.claude, repoRoot, claudeCommands, cache);
  const codex = scanHooks(files.codex, repoRoot, codexCommands, cache);
  if (!claude || !codex) return { ok: false, detail: "a runtime configuration file is unreadable" };
  const foreign = claude.scan.foreign.length + codex.scan.foreign.length;
  const total = claude.scan.deliver + claude.scan.wake + codex.scan.deliver + codex.scan.wake + foreign;
  let detail: string | undefined;
  if (foreign > 0) detail = `a hook command names another checkout: ${claude.reason ?? codex.reason ?? UNVERIFIED}`;
  else if (total === 0) detail = "no delivery or wake hook is installed";
  return { ok: foreign === 0 && total > 0, checkout: repoRoot, claude: claude.scan, codex: codex.scan, ...(detail ? { detail } : {}) };
}

// Issue #408: whether the Codex config runs this checkout's delivery hook (or
// one of a source of the same identity) on PostToolUse, which records the tool
// boundaries that keep a running turn from reading idle. An unreadable config is false.
export function codexPostToolHookInstalled(codexConfig: string, repoRoot: string): boolean {
  return (scanHooks(codexConfig, repoRoot, (text) => codexCommands(text, "PostToolUse"), sourceCache(repoRoot))?.scan.deliver ?? 0) > 0;
}

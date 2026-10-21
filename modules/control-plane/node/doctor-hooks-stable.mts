import fs from "node:fs";
import path from "node:path";

import * as claudeEntry from "../../../claude/kherep/control-plane/claude-control-plane-hook.mts";
import * as codexEntry from "../../../codex/hooks/control-plane-hook.mts";

// The stable form of a control-plane hook command, per runtime (issue #503 for
// Codex, #592 for Claude): the command names the runtime's entry point under its
// home and a fixed hook name; the hook it runs is the one the home's pointer
// names, and only through that home's own entry point. A command still naming
// the hook path is legacy until the runtime's installer rewrites it. doctor-hooks.mts
// resolves the counted names to hook files and checks them like any other.

export type PointerStatus = "valid" | "missing" | "invalid" | "unresolved";
export type EntryStatus = "valid" | "missing" | "symlink" | "stale" | "unchecked";
export type HookKind = "deliver" | "wake";

export interface StableForm {
  label: "Claude" | "Codex";
  // The installer the detail lines name.
  installer: string;
  entryName: string;
  // The only admitted entry directory, from the canonical home.
  entryDir: (home: string) => string;
  pointerFile: (home: string) => string;
  // The resolver of the runtime's own entry point.
  resolveHook: typeof claudeEntry.resolveHook | typeof codexEntry.resolveHook;
  // The file the installer copies the entry point from, under the pointer's root.
  sourceEntry: string[];
  // Groups: entry (quoted) or bare (unquoted) for the entry path, name for the hook name.
  command: RegExp;
  // The names that run a counted hook; the others (attribution) are stable but not counted.
  counted: Readonly<Partial<Record<string, HookKind>>>;
  legacy: RegExp;
}

export const CODEX: StableForm = {
  label: "Codex", installer: "codex/install.mts", entryName: codexEntry.ENTRY_NAME,
  entryDir: (home: string) => path.join(home, "hooks", "kherep-maestro"),
  pointerFile: codexEntry.pointerFile, resolveHook: codexEntry.resolveHook,
  sourceEntry: ["codex", "hooks", "control-plane-hook.mts"],
  command: /"(?<entry>[^"\n]*[\\/]codex-control-plane-hook\.mts)"\s+"(?<name>deliver|attribution)"/,
  counted: { deliver: "deliver" },
  legacy: /[\\/]modules[\\/]control-plane[\\/]node[\\/](?:deliver|attribution)-hook\.mts["']?\s+["']?--runtime["']?\s+["']?codex\b/,
};

// The rendered Claude command: `node "<home>/kherep/control-plane/claude-control-plane-hook.mts" <name> ...`.
// Only a command naming the entry point's file is stable; any other script that
// takes a hook name as its argument is an operator hook.
export const CLAUDE: StableForm = {
  label: "Claude", installer: "bootstrap/install.sh", entryName: claudeEntry.ENTRY_NAME,
  entryDir: (home: string) => path.join(home, "kherep", "control-plane"),
  pointerFile: claudeEntry.pointerFile, resolveHook: claudeEntry.resolveHook,
  sourceEntry: ["claude", "kherep", "control-plane", "claude-control-plane-hook.mts"],
  command: /^node\s+(?:"(?<entry>[^"\n]*[\\/]claude-control-plane-hook\.mts)"|(?<bare>\S*[\\/]claude-control-plane-hook\.mts))\s+(?<name>deliver|wake|attribution)(?:\s|$)/,
  counted: { deliver: "deliver", wake: "wake" },
  legacy: /[\\/]modules[\\/]control-plane[\\/]node[\\/](?:deliver|wake|attribution)-hook\.mts/,
};

// The entry path and hook name a stable command carries, or null for any other command.
export function stableCommand(form: StableForm, command: string): { entry: string; name: string } | null {
  const groups = form.command.exec(command)?.groups;
  if (!groups?.name) return null;
  const entry = groups.entry ?? groups.bare;
  return entry ? { entry, name: groups.name } : null;
}

// The pointer of a home, read through the same resolver its entry point uses.
export function pointerRoot(form: StableForm, home: string): { root?: string; status: PointerStatus } {
  const resolved = form.resolveHook("deliver", form.pointerFile(home));
  if ("hook" in resolved) return { root: resolved.pointer.root, status: "valid" };
  return { status: resolved.reason === "missing" || resolved.reason === "invalid" ? resolved.reason : "unresolved" };
}

// The hook file a counted stable name runs from the pointer's root.
export function stableHook(root: string, kind: HookKind): string {
  return path.join(root, "modules", "control-plane", "node", `${kind}-hook.mts`);
}

// The entry point every stable command of this home runs: a regular file, not a
// link, with the bytes the installer copied from the pointer's source. Without a
// usable pointer the bytes are not compared ("unchecked").
export function entryStatus(form: StableForm, home: string, root: string | undefined): EntryStatus {
  const entryFile = path.join(form.entryDir(home), form.entryName);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(entryFile); } catch { return "missing"; }
  if (stat.isSymbolicLink()) return "symlink";
  if (!stat.isFile()) return "missing";
  if (!root) return "unchecked";
  try { return fs.readFileSync(entryFile).equals(fs.readFileSync(path.join(root, ...form.sourceEntry))) ? "valid" : "stale"; }
  catch { return "stale"; }
}

// The one problem of a runtime's stable commands, for the detail line; none when
// no command is stable or the pointer and entry are usable.
export function stableProblem(form: StableForm, scan: { stable?: number; pointer?: PointerStatus; entry?: EntryStatus }): string | undefined {
  if (!scan.stable) return undefined;
  if (scan.pointer !== "valid") return `the ${form.label} control-plane source pointer is ${scan.pointer}; run ${form.installer}`;
  if (scan.entry !== "valid") return `the ${form.label} control-plane entry point is ${scan.entry}; run ${form.installer}`;
  return undefined;
}

export function legacyNote(form: StableForm, scan: { legacy?: number }): string | undefined {
  return scan.legacy ? `${form.label} hook commands still name a source path; run ${form.installer} to migrate them` : undefined;
}

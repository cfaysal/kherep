// SessionStart hook: says whether the Confluence write path exists on this box.
//
// Codex cannot write to Confluence until the broker and everything it imports
// have been installed into <workspace>/tools/. That delivery belongs to the
// bootstrap installer, not to Codex, so this waits rather than acts.
//
// It replaces a proposed hourly task. The thing being watched changes exactly
// once, when the installer runs; an hourly job would report the same "still
// nothing" twenty-three times a day and be ignored by the second day. A session
// start is the moment the answer can actually be used.
//
// READ-ONLY with respect to what it watches: it never installs, never copies
// into tools/, and never touches Confluence. It writes one small state file in
// CODEX_HOME so that the transition can be announced once instead of forever.
//
// The module list is NOT a constant and not a count. It is the broker's own
// import graph, walked from the entry file, so a module added to the broker
// later is covered without anyone remembering to update this hook. A check that
// counted to nine would have reported "complete" on the day the tenth module
// arrived - and the missing one would have been an import the broker needs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface HookData {
  hook_event_name?: unknown;
  cwd?: unknown;
  [key: string]: unknown;
}

// The Codex broker. Its Claude twin sits beside it and is delivered by the same
// step, but this hook belongs to Codex and asks about Codex's own entry point.
export const ENTRY = "atl-confluence.mts";

export function normalize(value: unknown): string {
  return String(value || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function isKherepScope(
  data: HookData | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const cwd = normalize(data && data.cwd);
  if (!cwd) return false;
  const configuredValue = Object.hasOwn(env, "KHEREP_WORKSPACE") ? env.KHEREP_WORKSPACE : undefined;
  const configured = normalize(configuredValue === undefined
    ? path.join(env.USERPROFILE || env.HOME || os.homedir(), "Kherep")
    : configuredValue);
  return Boolean(configured && (cwd === configured || cwd.startsWith(`${configured}/`)));
}

export function toolsDir(env: NodeJS.ProcessEnv = process.env): string {
  const workspace = Object.hasOwn(env, "KHEREP_WORKSPACE") && env.KHEREP_WORKSPACE
    ? env.KHEREP_WORKSPACE
    : path.join(env.USERPROFILE || env.HOME || os.homedir(), "Kherep");
  return path.join(workspace, "tools");
}

export function statePath(env: NodeJS.ProcessEnv = process.env): string {
  const codexHome = env.CODEX_HOME
    || path.join(env.USERPROFILE || env.HOME || os.homedir(), ".codex");
  return path.join(codexHome, "orchestra", "confluence-delivery.json");
}

// Relative .mts imports only. An absolute or bare specifier is somebody else's
// problem; what this hook needs to know is which files must sit next to each
// other for the broker to load at all.
const RELATIVE_IMPORT = /from\s+["'](\.\.?\/[^"']+\.mts)["']/g;

export interface Delivery {
  present: string[];
  missing: string[];
  // True when the entry file itself is absent: nothing was delivered at all,
  // which is a different statement from "some modules are missing".
  absent: boolean;
}

export function inspect(dir: string, read: (file: string) => string, exists: (file: string) => boolean): Delivery {
  const present: string[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  const queue = [ENTRY];

  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const file = path.join(dir, name);
    if (!exists(file)) { missing.push(name); continue; }
    present.push(name);
    let source = "";
    try {
      source = read(file);
    } catch {
      // Unreadable is not absent, and saying otherwise would be the fail-soft
      // mistake this codebase keeps paying for. It counts as present and its
      // imports simply cannot be walked from here.
      continue;
    }
    for (const match of source.matchAll(RELATIVE_IMPORT)) {
      queue.push(path.basename(match[1]));
    }
  }
  return { present: present.sort(), missing: missing.sort(), absent: missing.includes(ENTRY) };
}

export function message(delivery: Delivery, announcedComplete: boolean): string {
  if (!delivery.missing.length) {
    if (announcedComplete) return "";
    return "CONFLUENCE DELIVERY: the write path is installed. The broker and all "
      + `${delivery.present.length} modules it imports are in tools/. The Confluence write test in `
      + "OP-1398 can be taken now; nothing else about that ticket changed.";
  }
  if (delivery.absent) {
    return "CONFLUENCE DELIVERY: not installed. No Confluence broker in tools/, so there is no "
      + "write path on this box at all. It is delivered by the bootstrap installer under OP-1405, "
      + "not by you - do not copy anything into tools/. The write test in OP-1398 stays blocked.";
  }
  return `CONFLUENCE DELIVERY: incomplete. ${delivery.present.length} of `
    + `${delivery.present.length + delivery.missing.length} files are in tools/; the broker would `
    + `fail to load. Missing: ${delivery.missing.join(", ")}. This is the installer's job (OP-1405), `
    + "not yours.";
}

async function main(): Promise<void> {
  let data: HookData;
  try {
    data = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return;
  }
  if (data.hook_event_name !== "SessionStart") return;
  if (!isKherepScope(data)) return;

  const delivery = inspect(
    toolsDir(),
    (file) => fs.readFileSync(file, "utf8"),
    (file) => fs.existsSync(file),
  );

  const state = statePath();
  let announced = false;
  try {
    announced = JSON.parse(fs.readFileSync(state, "utf8")).announcedComplete === true;
  } catch {
    // No state yet, or unreadable. Announcing once more is cheaper than staying
    // silent about a transition that has to be acted on.
  }

  const line = message(delivery, announced);
  if (line) process.stdout.write(`${line}\n`);

  const complete = delivery.missing.length === 0;
  if (complete !== announced) {
    try {
      fs.mkdirSync(path.dirname(state), { recursive: true });
      fs.writeFileSync(state, JSON.stringify({ announcedComplete: complete }, null, 2));
    } catch {
      // An unwritable state file means the line repeats. That is noise, never a
      // failure, and a hook must not trap a session over it.
    }
  }
}

// Node loads the main module from its real path, so a script started through a
// symlinked directory (macOS /var -> /private/var) only matches after realpath.
// It needs no main flag on import.meta, which Node 23 and 24.0-24.1 lack.
function isMainModule(): boolean {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] || "")).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch(() => {
    // Fail open: a reminder hook can never trap a Codex session.
  });
}

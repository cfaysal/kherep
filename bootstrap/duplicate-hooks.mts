// Issue #590. A control-plane script (deliver-hook, wake-hook, attribution-hook)
// wired more than once on one event runs twice per event and, for the wake
// listener, twice per session. An installer that keyed the replace rule on the
// full script path left the entries of an earlier install from another root in
// place: a node measured 16 entries instead of 8, and neither drift-check.sh
// (the merge kept both sets, so expected equalled live) nor `kherep-node doctor`
// (it counts hooks, not entries per event) noticed. The identity is the one the
// merge uses, controlPlaneHookKey(): the script from `modules/control-plane/node/`
// on, so the two roots count as one script. Groups (matchers) are not part of
// the identity: the merge replaces the script in every group of the event.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { controlPlaneHookKey } from "./managed-hook-key.mts";
import { errorMessage } from "./shape.mts";

export interface DuplicateHook { event: string; script: string; count: number }

// Any JSON shape: a settings file is read as written, so every level is checked.
export function duplicateControlPlaneHooks(settings: { hooks?: unknown }, platform: string = process.platform): DuplicateHook[] {
  const found: DuplicateHook[] = [];
  const hooks = settings.hooks;
  if (typeof hooks !== "object" || hooks === null) return found;
  for (const [event, entries] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    const counts = new Map<string, number>();
    for (const entry of entries) {
      const list = (entry as { hooks?: unknown } | null)?.hooks;
      for (const hook of (Array.isArray(list) ? list : []) as { command?: unknown }[]) {
        if (typeof hook?.command !== "string") continue;
        const script = controlPlaneHookKey(hook.command, platform);
        if (script !== undefined) counts.set(script, (counts.get(script) ?? 0) + 1);
      }
    }
    for (const [script, count] of counts) if (count > 1) found.push({ event, script, count });
  }
  return found;
}

// drift-check.sh: `<settings.json>` prints one DUPLICATE-HOOK line per finding,
// the script as its key (no root, no extension); exit 0 clean, 3 findings,
// 1 error. A file that does not exist wires nothing and is clean.
function main(argv: string[]): number {
  const [file] = argv;
  if (!file) throw new Error("usage: <settings.json>");
  if (!fs.existsSync(file)) return 0;
  const found = duplicateControlPlaneHooks(JSON.parse(fs.readFileSync(file, "utf8")) as { hooks?: unknown });
  for (const item of found) console.log(`DUPLICATE-HOOK ${item.event} ${item.script} x${item.count}`);
  return found.length ? 3 : 0;
}

// As in retired-hooks.mts: the main module by its given or its real path.
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
  catch (error) { console.error(`FATAL: duplicate hook check failed: ${errorMessage(error)}`); process.exitCode = 1; }
}

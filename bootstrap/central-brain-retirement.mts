// Retirement of the server-based Central Brain hooks (OP-1429).
//
// A host that once enrolled carries up to five hook commands in its user
// settings, written by the retired central-brain-hooks.mts. They call a server
// that no longer exists. mergeSettings keeps every host hook it does not know,
// so not adding them any more would leave them running forever: they have to
// be taken out of the existing settings before the merge.
//
// The match is the exact command shape that module produced and nothing wider.
// A hook the operator wrote by hand stays. The previous settings.json and the
// selection file both land in the install backup: settings.json through
// install_path, selection.json through bootstrap/manifest/retired.txt.
//
// A NODE_EXTRA_CA_CERTS entry the selection may have contributed is left in
// place on purpose: the same bundle can be what other clients on the host
// trust, and removing trust is not something an upgrade may guess at.

import type { HookEntry, Settings } from "./render-profile-settings.mts";

const RETIRED_COMMAND =
  /^node "[^"]*\/dist\/src\/cli\/(?:native-context\.js|claude-capture\.mjs)" claude --profile "[^"]*"$/;

export function isRetiredCentralBrainCommand(command: unknown): boolean {
  return typeof command === "string" && RETIRED_COMMAND.test(command.replace(/\\/g, "/"));
}

export function retireCentralBrainHooks(existing: Settings): { settings: Settings; removed: number } {
  if (!existing.hooks || typeof existing.hooks !== "object") return { settings: existing, removed: 0 };
  let removed = 0;
  const hooks: Record<string, HookEntry[]> = {};
  for (const [event, entries] of Object.entries(existing.hooks)) {
    if (!Array.isArray(entries)) { hooks[event] = entries; continue; }
    const kept = entries.flatMap((entry) => {
      if (!entry || !Array.isArray(entry.hooks)) return [entry];
      const remaining = entry.hooks.filter((hook) => !isRetiredCentralBrainCommand(hook?.command));
      removed += entry.hooks.length - remaining.length;
      if (remaining.length === entry.hooks.length) return [entry];
      return remaining.length ? [{ ...entry, hooks: remaining }] : [];
    });
    // An event that only ever held Central Brain hooks disappears with them;
    // an event that was already empty on the host stays as the host wrote it.
    if (kept.length || !entries.length) hooks[event] = kept;
  }
  return removed ? { settings: { ...existing, hooks }, removed } : { settings: existing, removed };
}

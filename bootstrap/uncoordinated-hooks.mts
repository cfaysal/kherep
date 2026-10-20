// Issue #525. Which kept hook commands live-hook-integrity.mts will refuse to
// run beside, by its own rule (hooks/lib/hook-inventory.mts), and the line the
// install output prints for each. Only data safe by construction is printed:
// event, matcher, and the hook files the gate counted, relative to <home>/hooks.
import { wiredFiles } from "../claude/hooks/lib/hook-inventory.mts";
import { normalizePathLike } from "../claude/hooks/lib/workspace-scope.mts";
import type { Settings } from "./render-profile-settings.mts";

export interface KeptHook { event: string; matcher?: string; command: string; files: string[] }

// A plain event name, and the tool-name regex alphabet for a matcher: neither
// can spell a path (no `/`, `\`, `:`, whitespace or quotes).
const EVENT_SHOWN = /^[A-Za-z][A-Za-z0-9]{0,79}$/;
const MATCHER_SHOWN = /^[A-Za-z0-9_|.*^$()?+\[\]{},-]{1,80}$/;

// Each command is judged alone, as the only command of a settings.json the gate
// reads; `command` is carried for the parity test and never printed.
export function keptUncoordinatedHooks(rendered: Settings, claudeHome: string): KeptHook[] {
  const home = normalizePathLike(claudeHome);
  const enoent = Object.assign(new Error("absent"), { code: "ENOENT" });
  const out: KeptHook[] = [];
  for (const [event, entries] of Object.entries(rendered.hooks ?? {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!Array.isArray(entry?.hooks)) continue;
      for (const hook of entry.hooks) {
        if (typeof hook?.command !== "string") continue;
        const { uncoordinated, files } = wiredFiles(home, (name) => {
          if (name === "settings.json") return JSON.stringify({ hooks: { [event]: [{ hooks: [hook] }] } });
          throw enoent;
        });
        if (uncoordinated.length) {
          out.push({ event, matcher: typeof entry.matcher === "string" ? entry.matcher : undefined,
            command: hook.command, files: files.map((file) => file.rel) });
        }
      }
    }
  }
  return out;
}

// A quoted token can carry a line break into rel; the line stays one line.
const show = (rel: string) => rel.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
const label = (matcher?: string) => (matcher && MATCHER_SHOWN.test(matcher) ? ` [${matcher}]` : "");

export function keptHookLines(rendered: Settings, claudeHome: string): string[] {
  return keptUncoordinatedHooks(rendered, claudeHome).map(({ event, matcher, files }) =>
    `hooks: keep ${EVENT_SHOWN.test(event) ? event : "<event>"}${label(matcher)} `
    + `${files.map((rel) => `<claude-home>/hooks/${show(rel)}`).join(", ")} (uncoordinated, blocks live-hook-integrity)`);
}

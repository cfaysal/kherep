import { command } from "./parity-config.mts";

// Issue #70. The deliver hook runs from the checkout, so a block written from
// another checkout names a path that no fragment of this install renders. The
// stable suffix and the runtime argument identify the hook, not the checkout:
// point every such command in the managed block at the current checkout before
// the block is matched. Both `command` and `commandWindows` carry the same form.
const DELIVER_HOOK = /\\"((?:[^"\\]|\\\\)*?(?:\\\\|\/)modules(?:\\\\|\/)control-plane(?:\\\\|\/)node(?:\\\\|\/)deliver-hook\.mts)\\" \\"--runtime\\" \\"codex\\"/g;

export function pointDeliverHooksAt(
  config: string, controlPlaneHook: string | undefined, startMarker: string, endMarker: string,
): string {
  const start = config.indexOf(startMarker);
  const end = start < 0 ? -1 : config.indexOf(endMarker, start);
  if (!controlPlaneHook || end < 0) return config;
  // The hook path exactly as a rendered TOML string spells it.
  const current = JSON.stringify(command(controlPlaneHook)).slice(3, -3);
  const body = config.slice(start, end)
    .replace(DELIVER_HOOK, () => `\\"${current}\\" \\"--runtime\\" \\"codex\\"`);
  return config.slice(0, start) + body + config.slice(end);
}

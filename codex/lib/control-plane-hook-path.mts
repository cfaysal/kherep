import { command, hookGroup } from "./parity-config.mts";

// Issue #70. The deliver hook runs from the checkout, so a block written from
// another checkout names a path that no fragment of this install renders. The
// stable suffix and the runtime argument identify the hook, not the checkout:
// point every such command in the managed block at the current checkout before
// the block is matched. Both `command` and `commandWindows` carry the same form.
const DELIVER_HOOK = /\\"((?:[^"\\]|\\\\)*?(?:\\\\|\/)modules(?:\\\\|\/)control-plane(?:\\\\|\/)node(?:\\\\|\/)deliver-hook\.mts)\\" \\"--runtime\\" \\"codex\\"/g;
const DELIVER_COMMAND = new RegExp(`^command = ".*${DELIVER_HOOK.source}"$`, "m");
// Issue #325, PR-A. The attribution hook sits beside the deliver hook in the
// same checkout directory and is pointed at the current checkout with it.
const CHECKOUT_HOOK = /\\"((?:[^"\\]|\\\\)*?(?:\\\\|\/)modules(?:\\\\|\/)control-plane(?:\\\\|\/)node(?:\\\\|\/))(deliver|attribution)-hook\.mts\\" \\"--runtime\\" \\"codex\\"/g;
const DELIVER_EVENTS = [
  ["SessionStart", "startup|resume|clear|compact"],
  ["UserPromptSubmit", ""],
  ["Stop", ""],
] as const;

function hookGroups(config: string): string[] {
  const tables = config.split(/^(?=\[)/m);
  const groups: string[] = [];
  for (let index = 0; index < tables.length;) {
    const event = /^\[\[hooks\.(\w+)\]\]\n/.exec(tables[index])?.[1];
    if (!event) { index += 1; continue; }
    let next = index + 1;
    while (next < tables.length && /^\[\[?hooks\.(\w+)\./.exec(tables[next])?.[1] === event) next += 1;
    groups.push(tables.slice(index, next).join("").trim());
    index = next;
  }
  return groups;
}

export function hasExactExternalDeliverHooks(
  config: string, node: string, controlPlaneHook: string | undefined,
  startMarker: string, endMarker: string,
): boolean {
  if (!controlPlaneHook) return false;
  const start = config.indexOf(startMarker);
  const end = start < 0 ? -1 : config.indexOf(endMarker, start);
  if (start >= 0 && end < start) return false;
  const external = start < 0 ? config
    : config.slice(0, start) + config.slice(end + endMarker.length);
  const bound = command(node, controlPlaneHook, "--runtime", "codex");
  const hook = { command: bound, commandWindows: `& ${bound}` };
  const groups = hookGroups(external);
  return DELIVER_EVENTS.every(([event, matcher]) => {
    const expected = hookGroup(event, matcher, [hook]);
    return groups.filter((group) => group === expected).length === 1;
  });
}

export function pointDeliverHooksAt(
  config: string, controlPlaneHook: string | undefined, startMarker: string, endMarker: string,
): string {
  const start = config.indexOf(startMarker);
  const end = start < 0 ? -1 : config.indexOf(endMarker, start);
  if (!controlPlaneHook || end < 0) return config;
  // The hook path exactly as a rendered TOML string spells it.
  const current = JSON.stringify(command(controlPlaneHook)).slice(3, -3);
  const dir = current.slice(0, -"deliver-hook.mts".length);
  const body = config.slice(start, end)
    .replace(CHECKOUT_HOOK, (_match, _dir, name: string) => `\\"${dir}${name}-hook.mts\\" \\"--runtime\\" \\"codex\\"`);
  return config.slice(0, start) + dropSurplusDeliverGroups(body) + config.slice(end);
}

// Older installs left a second set of deliver-hook groups in the block. Keep the
// first group per event whose hooks are all deliver hooks and drop the later
// ones. A group that mixes a deliver hook with another hook is never touched.
function dropSurplusDeliverGroups(body: string): string {
  const tables = body.split(/^(?=\[)/m);
  const seen = new Set<string>();
  const kept: string[] = [];
  let dropped = false;
  let index = 0;
  while (index < tables.length) {
    const event = /^\[\[hooks\.(\w+)\]\]\n/.exec(tables[index])?.[1];
    if (!event) {
      kept.push(tables[index]);
      index += 1;
      continue;
    }
    // A group owns every following table under its own event path.
    let next = index + 1;
    while (next < tables.length && /^\[\[?hooks\.(\w+)\./.exec(tables[next])?.[1] === event) next += 1;
    const hooks = tables.slice(index + 1, next);
    const deliverOnly = hooks.length > 0 && hooks.every((table) =>
      table.startsWith(`[[hooks.${event}.hooks]]\n`) && DELIVER_COMMAND.test(table));
    if (deliverOnly && seen.has(event)) {
      dropped = true;
    } else {
      if (deliverOnly) seen.add(event);
      kept.push(...tables.slice(index, next));
    }
    index = next;
  }
  return dropped ? kept.join("").replace(/\n{2,}$/, "\n") : body;
}

import crypto from "node:crypto";

export type JsonObject = Record<string, unknown>;
export interface OwnedHook { event: string; matcher: string | null; handlerSha256: string }
export interface ObserverReceipt {
  version: 1;
  kind: "kherep-idle-observer";
  runId: string;
  armNonce: string;
  state: "prepared" | "installed" | "removing" | "removed";
  expiresAt: string;
  codeSha256: string;
  settingsSha256Before: string;
  settingsSha256After: string;
  backupSha256: string;
  hooks: OwnedHook[];
}

export interface HookCommand { type: "command"; command: string; args: string[]; timeout: number }
export interface PlannedHook { event: string; matcher: string | null; handler: HookCommand }

const TYPE_STRIPPING_WARNING_FLAG = "--disable-warning=ExperimentalWarning";

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export const sha256 = (value: string | Buffer): string => crypto.createHash("sha256").update(value).digest("hex");
export const objectSha256 = (value: unknown): string => sha256(canonical(value));

export function validSettings(value: unknown): value is JsonObject {
  if (!isObject(value)) return false;
  if (value.hooks === undefined) return true;
  if (!isObject(value.hooks)) return false;
  return Object.values(value.hooks).every((groups) => Array.isArray(groups) && groups.every((group) =>
    isObject(group) && Array.isArray(group.hooks) && group.hooks.every(isObject)));
}

export function plannedHooks(nodePath: string, observerFile: string, runDir: string,
  armNonce: string, runId: string): PlannedHook[] {
  const handler: HookCommand = {
    type: "command",
    command: nodePath,
    args: [TYPE_STRIPPING_WARNING_FLAG, observerFile, "callback", "--run-dir", runDir,
      "--arm", armNonce, "--run-id", runId],
    timeout: 10,
  };
  return [
    { event: "Notification", matcher: "^idle_prompt$", handler },
    { event: "SessionStart", matcher: "*", handler },
    { event: "UserPromptSubmit", matcher: null, handler },
  ];
}

function groups(settings: JsonObject, event: string): JsonObject[] {
  const hooks = settings.hooks as JsonObject | undefined;
  return (hooks?.[event] as JsonObject[] | undefined) ?? [];
}

function commands(settings: JsonObject): Array<{ event: string; matcher: string | null; handler: JsonObject }> {
  const hooks = settings.hooks as JsonObject | undefined;
  if (!hooks) return [];
  return Object.entries(hooks).flatMap(([event, rawGroups]) => (rawGroups as JsonObject[]).flatMap((group) =>
    (group.hooks as JsonObject[]).map((handler) => ({
      event,
      matcher: typeof group.matcher === "string" ? group.matcher : null,
      handler,
    }))));
}

function marker(handler: JsonObject, runId: string): boolean {
  if (!Array.isArray(handler.args)) return false;
  const index = handler.args.indexOf("--run-id");
  return index >= 0 && handler.args[index + 1] === runId;
}

export function hasObserverCommand(settings: JsonObject, observerFile: string): boolean {
  return commands(settings).some(({ handler }) => {
    if (!Array.isArray(handler.args)) return false;
    const offset = handler.args[0] === TYPE_STRIPPING_WARNING_FLAG ? 1 : 0;
    return handler.args[offset] === observerFile && handler.args[offset + 1] === "callback";
  });
}

export function addOwnedHooks(settings: JsonObject, plan: PlannedHook[]): { settings: JsonObject; hooks: OwnedHook[] } {
  const result = structuredClone(settings);
  const hooks = isObject(result.hooks) ? result.hooks : {};
  result.hooks = hooks;
  const owned: OwnedHook[] = [];
  for (const item of plan) {
    const current = Array.isArray(hooks[item.event]) ? hooks[item.event] as JsonObject[] : [];
    const group: JsonObject = { ...(item.matcher === null ? {} : { matcher: item.matcher }), hooks: [structuredClone(item.handler)] };
    hooks[item.event] = [...current, group];
    owned.push({ event: item.event, matcher: item.matcher, handlerSha256: objectSha256(item.handler) });
  }
  return { settings: result, hooks: owned };
}

export function hasOwnedMarker(settings: JsonObject, receipt: ObserverReceipt): boolean {
  return commands(settings).some(({ handler }) => marker(handler, receipt.runId));
}

export function inspectOwned(settings: JsonObject, receipt: ObserverReceipt,
  expectedPresent = receipt.state !== "removed"): { exact: number; drift: boolean } {
  const all = commands(settings);
  if (!expectedPresent) return { exact: 0, drift: hasOwnedMarker(settings, receipt) };
  let exact = 0;
  let drift = false;
  const used = new Set<number>();
  for (const expected of receipt.hooks) {
    const candidates = all.map((item, index) => ({ ...item, index }))
      .filter((item) => item.event === expected.event && item.matcher === expected.matcher && marker(item.handler, receipt.runId));
    const match = candidates.find((item) => objectSha256(item.handler) === expected.handlerSha256 && !used.has(item.index));
    if (!match) drift = true;
    else { exact++; used.add(match.index); }
    if (candidates.some((item) => objectSha256(item.handler) !== expected.handlerSha256)) drift = true;
  }
  if (all.some((item, index) => marker(item.handler, receipt.runId) && !used.has(index))) drift = true;
  return { exact, drift };
}

export function removeOwnedHooks(settings: JsonObject, receipt: ObserverReceipt): JsonObject | null {
  const state = inspectOwned(settings, receipt, true);
  if (state.drift || state.exact !== receipt.hooks.length) return null;
  const result = structuredClone(settings);
  const hooks = result.hooks as JsonObject;
  for (const expected of receipt.hooks) {
    const next: JsonObject[] = [];
    let removed = false;
    for (const group of groups(result, expected.event)) {
      const matcherValue = typeof group.matcher === "string" ? group.matcher : null;
      if (matcherValue !== expected.matcher) { next.push(group); continue; }
      const kept = (group.hooks as JsonObject[]).filter((handler) => {
        if (!removed && marker(handler, receipt.runId) && objectSha256(handler) === expected.handlerSha256) {
          removed = true;
          return false;
        }
        return true;
      });
      const extras = Object.keys(group).filter((key) => key !== "matcher" && key !== "hooks");
      if (kept.length > 0 || extras.length > 0) next.push({ ...group, hooks: kept });
    }
    if (next.length > 0) hooks[expected.event] = next;
    else delete hooks[expected.event];
  }
  if (Object.keys(hooks).length === 0) delete result.hooks;
  return result;
}

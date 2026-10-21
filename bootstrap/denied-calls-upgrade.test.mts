// Issue #504. An upgrade over the previous template keeps exactly one entry of the delivery
// recorder and duplicates no other hook. mergeHooks treats an entry whose fields differ as another
// hook, so this change only appends its entry to the existing SubagentHandback group and edits no
// other entry. The previous template is the current one without the recorder entry, which is what
// main held before this change; a variant also holds an operator's own entry in that group.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { renderSettings } from "./render-profile.mts";

interface Hook { command: string; timeout?: number }
interface Group { matcher?: string; hooks: Hook[] }
interface Settings { hooks: Record<string, Group[]> }

const repo = path.resolve(import.meta.dirname, "..");
const template = JSON.parse(fs.readFileSync(path.join(repo, "claude", "settings.user.json"), "utf8")) as Settings;
const RECORDER = "/hooks/denied-calls-delivered.mts";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "denied-calls-upgrade-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const file = (name: string, value?: unknown): string => {
  const target = path.join(dir, name);
  if (value !== undefined) fs.writeFileSync(target, JSON.stringify(value));
  return target;
};

// The template without the recorder entry, its group dropped when it empties; `foreign` adds an entry there first.
function previous(foreign?: Hook): Settings {
  const copy = structuredClone(template);
  copy.hooks.PostToolUse = copy.hooks.PostToolUse!.flatMap((group) => {
    const hooks = group.hooks.filter((hook) => !hook.command.includes(RECORDER));
    if (group.matcher === "SubagentHandback" && foreign) hooks.push(foreign);
    return hooks.length ? [{ ...group, hooks }] : [];
  });
  return copy;
}

// One installer render of source over existing ("-": a fresh home), as install.sh runs it.
function render(source: Settings, existing: string, out: string): string {
  const project = file("project.src.json", {});
  const log = console.log;
  console.log = () => {};
  try {
    renderSettings(["mac", "/ws", "/creds", "/home/.claude", file(`${out}.src.json`, source), project, existing, "-", file(`${out}.json`), file(`${out}.project.json`)]);
  } finally { console.log = log; }
  return path.join(dir, `${out}.json`);
}

const read = (target: string): Settings => JSON.parse(fs.readFileSync(target, "utf8"));
// Every hook command per event, in order.
const commands = (settings: Settings): string[] =>
  Object.entries(settings.hooks).flatMap(([event, groups]) => groups.flatMap((group) => group.hooks.map((hook) => `${event} ${group.matcher ?? ""} ${hook.command}`)));
const counts = (list: string[]): Map<string, number> => list.reduce((map, key) => map.set(key, (map.get(key) ?? 0) + 1), new Map<string, number>());

test("the previous template lacks only the recorder entry", () => {
  const removed = commands(template).filter((line) => !commands(previous()).includes(line));
  assert.equal(removed.length, 1);
  assert.match(removed[0]!, /^PostToolUse SubagentHandback .*denied-calls-delivered\.mts"$/);
});

for (const variant of ["main", "with an operator entry in the handback group"] as const) {
  test(`an upgrade from ${variant} wires the recorder once and duplicates nothing; a second run changes nothing`, () => {
    const foreign = variant === "main" ? undefined : { command: "node \"__KHEREP_CLAUDE_HOME__/hooks/other-handback.mts\"", timeout: 10 };
    const before = render(previous(foreign), "-", `${variant}-before`);
    const upgraded = render(template, before, `${variant}-after`);
    const again = render(template, upgraded, `${variant}-again`);
    const after = read(upgraded);
    const recorder = commands(after).filter((line) => line.includes(RECORDER));
    assert.equal(recorder.length, 1, recorder.join("\n"));
    const handback = after.hooks.PostToolUse!.filter((group) => group.matcher === "SubagentHandback");
    assert.equal(handback.length, 1);
    assert.deepEqual(handback[0]!.hooks.map((hook) => [path.basename(hook.command.split("\"").at(-2) ?? ""), hook.timeout]),
      [["obs-handback-record.mts", 10], ["denied-calls-delivered.mts", 10], ...(foreign ? [["other-handback.mts", 10]] : [])]);
    for (const [line, count] of counts(commands(after))) assert.equal(count, 1, `${line} is wired ${count} times`);
    assert.deepEqual(commands(after).filter((line) => !line.includes(RECORDER)), commands(read(before)));
    assert.deepEqual(read(again), after);
  });
}

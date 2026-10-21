// Issue #555. An upgrade renders the new settings template over the settings
// the previous template produced. Until issue #568 the merge identified a hook
// by every field but its command, so a changed field such as a timeout on an
// existing entry kept the old entry next to the new one, and two
// obs-result-check instances would have raced over the same handback record;
// managed-hook-upgrade-render.test.mts now covers that replace rule. The
// previous template is this one without the SubagentHandback PostToolUse group,
// with the SubagentStop entry as main carried it before #555.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { renderSettings } from "./render-profile.mts";

interface Hook { command?: string; [key: string]: unknown }
interface Group { matcher?: string; hooks: Hook[] }
type Hooks = Record<string, Group[]>;

const SOURCE = path.join(import.meta.dirname, "..", "claude", "settings.user.json");
const PREVIOUS_STOP_ENTRY: Hook = {
  type: "command",
  command: 'node "__KHEREP_CLAUDE_HOME__/kherep/hook-runtime/entry.mts" reader "__KHEREP_CLAUDE_HOME__/hooks/obs-result-check.mts"',
};

function previousTemplate(): unknown {
  const settings = JSON.parse(fs.readFileSync(SOURCE, "utf8")) as { hooks: Hooks };
  settings.hooks.PostToolUse = settings.hooks.PostToolUse!.filter((group) => group.matcher !== "SubagentHandback");
  const stop = settings.hooks.SubagentStop!.find((group) => group.matcher === "claude-obs")!;
  stop.hooks = [PREVIOUS_STOP_ENTRY];
  return settings;
}

function wired(hooks: Hooks, main: string): { event: string; matcher: string }[] {
  return Object.entries(hooks).flatMap(([event, groups]) => groups.flatMap((group) => group.hooks
    .filter((hook) => typeof hook.command === "string" && hook.command.includes(`/hooks/${main}"`))
    .map(() => ({ event, matcher: group.matcher ?? "" }))));
}

test("an upgrade from the previous template keeps exactly one entry of each observation hook", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-hooks-upgrade-render-"));
  try {
    const previous = path.join(dir, "previous.user.json");
    const project = path.join(dir, "project.src.json");
    fs.writeFileSync(previous, JSON.stringify(previousTemplate()));
    fs.writeFileSync(project, "{}");
    for (const profile of ["win", "mac"]) {
      const out = (name: string) => path.join(dir, `${profile}.${name}.json`);
      const args = (source: string, existingUser: string, existingProject: string, user: string, proj: string) =>
        [profile, "/example/Kherep", "/example/credentials", "/example/.claude", source, project, existingUser, existingProject, user, proj];
      renderSettings(args(previous, "-", "-", out("user.before"), out("project.before")));
      renderSettings(args(SOURCE, out("user.before"), out("project.before"), out("user.after"), out("project.after")));
      const before = (JSON.parse(fs.readFileSync(out("user.before"), "utf8")) as { hooks: Hooks }).hooks;
      const after = (JSON.parse(fs.readFileSync(out("user.after"), "utf8")) as { hooks: Hooks }).hooks;
      assert.deepEqual(wired(before, "obs-handback-record.mts"), [], `${profile}: the previous template has no recorder`);
      assert.deepEqual(wired(after, "obs-result-check.mts"), [{ event: "SubagentStop", matcher: "claude-obs" }], profile);
      assert.deepEqual(wired(after, "obs-handback-record.mts"), [{ event: "PostToolUse", matcher: "SubagentHandback" }], profile);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

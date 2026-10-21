// Issue #504. The Codex adapter's main() journals a delegated call's verdict once, through the
// installed journal lib beside it, and capture never changes the decision: a lib that is missing,
// empty, throws or hangs leaves the deny JSON as without capture, exit 0, within the deadline.
// preToolUse() and runAdaptedHook(), which the shell dispatcher calls in-process, never journal.
// Capture stays inert until a Codex child payload carries agent_id (#537); these payloads carry one.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";

import { journalPaths } from "../../claude/hooks/lib/denial-journal.mts";
import { readJournal, renderReport } from "../../claude/hooks/lib/denial-report.mts";
import { cleanupHomes, codexHome, exit2, run, scrub, shellPayload, type CodexHome } from "./denials-fixture.mts";

after(cleanupHomes);
const GUARDS = { "codex-guard.mts": exit2("codex-guard"), "allow.mts": "process.exit(0);\n" };
const adapt = (home: CodexHome, guard: string, input: string) =>
  run([path.join(home.hookDir, "codex-hook-adapter.mts"), path.join(home.hookDir, guard), "pre"], input);
const lines = (home: CodexHome): Record<string, unknown>[] => {
  const file = journalPaths(home.root, "agent-c1").journal;
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
};

test("a delegated deny is journalled once with its target; without agent_id nothing is written", async () => {
  const home = codexHome(GUARDS);
  const plain = await adapt(home, "codex-guard.mts", shellPayload({ agent_id: undefined }));
  assert.equal(fs.existsSync(journalPaths(home.root, "x").dir), false);
  const delegated = await adapt(home, "codex-guard.mts", shellPayload());
  assert.equal(delegated.status, 0, delegated.stderr);
  assert.equal(delegated.stdout, plain.stdout);
  assert.equal(JSON.parse(delegated.stdout).hookSpecificOutput.permissionDecision, "deny");
  const [line, extra] = lines(home);
  assert.equal(extra, undefined);
  assert.deepEqual([line!.tool, line!.id, line!.decision], ["shell_command", "call_1", "deny"]);
  assert.deepEqual(line!.denials, [{ guard: "codex-guard", target: "git", reason: "[codex-guard] codex-guard says no", broken: false }]);
  await adapt(home, "allow.mts", shellPayload({ tool_use_id: "call_2" }));
  assert.equal(lines(home).length, 2);
  assert.equal(renderReport(readJournal(home.root, "agent-c1")).text.split("\n")[0], "DENIED-CALLS: 1");
});

for (const lib of ["missing", "empty", "throwing", "hanging"] as const) {
  test(`an installed journal lib that is ${lib}: the same deny, exit 0, a marker`, async () => {
    const referenceHome = codexHome(GUARDS);
    const reference = await adapt(referenceHome, "codex-guard.mts", shellPayload());
    const home = codexHome(GUARDS, lib);
    const result = await adapt(home, "codex-guard.mts", shellPayload());
    assert.equal(result.status, 0);
    assert.equal(scrub(result.stdout, home), scrub(reference.stdout, referenceHome));
    assert.equal(fs.readFileSync(journalPaths(home.root, "agent-c1").marker, "utf8"), lib === "hanging" ? "lib-timeout\n" : "lib-load\n");
    assert.ok(result.ms < 8_500, `${result.ms} ms`);
  });
}

test("runAdaptedHook, the in-process path, writes nothing", async () => {
  const home = codexHome(GUARDS);
  const adapter = await import(pathToFileURL(path.join(home.hookDir, "hook-adapter.mts")).href) as typeof import("./hook-adapter.mts");
  const result = adapter.runAdaptedHook(path.join(home.hookDir, "codex-guard.mts"), "pre", JSON.parse(shellPayload()), 5_000);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(journalPaths(home.root, "x").dir), false);
});

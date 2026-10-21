// Issue #504. The Codex shell dispatcher journals every denying guard of a delegated call, not only
// the first, after its guards and before the re-check; a journal lib that fails or a writer that
// stalls leaves the decision as it was, within the deadline, and an adapter that does not load
// leaves the capture-failed marker. Inert until a Codex child payload carries agent_id (#537).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { denialFaultEnv } from "../../claude/hooks/denial-fault.fixture.mts";
import { journalPaths } from "../../claude/hooks/lib/denial-journal.mts";
import { readJournal, renderReport } from "../../claude/hooks/lib/denial-report.mts";
import { cleanupHomes, codexHome, exit2, run, scrub, shellPayload, type CodexHome } from "./denials-fixture.mts";

after(cleanupHomes);
const GUARDS = { "commit-guard.mts": exit2("commit-guard"), "deploy-guard.mts": "process.exit(0);\n", "main-checkout-guard.mts": exit2("main-checkout") };
const shell = (home: CodexHome, input: string, env?: NodeJS.ProcessEnv) => run([path.join(home.hookDir, "codex-shell-checks.mts")], input, env);
const first = (home: CodexHome): string => renderReport(readJournal(home.root, "agent-c1")).text.split("\n")[0]!;

test("two denying guards: two denials journalled, the decision as without agent_id", async () => {
  const home = codexHome(GUARDS);
  const plain = await shell(home, shellPayload({ agent_id: undefined }));
  const delegated = await shell(home, shellPayload());
  assert.equal(delegated.status, 0, delegated.stderr);
  assert.equal(delegated.stdout, plain.stdout);
  const [line] = fs.readFileSync(journalPaths(home.root, "agent-c1").journal, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(line.denials.map((d: { guard: string; target: string }) => [d.guard, d.target]), [["commit-guard", "git"], ["main-checkout", "git"]]);
  assert.equal(first(home), "DENIED-CALLS: 2");
});

test("a journal lib that throws: the same decision and a marker", async () => {
  const referenceHome = codexHome(GUARDS);
  const reference = await shell(referenceHome, shellPayload());
  const home = codexHome(GUARDS, "throwing");
  const result = await shell(home, shellPayload());
  assert.equal(scrub(result.stdout, home), scrub(reference.stdout, referenceHome));
  assert.equal(first(home), "DENIED-CALLS: unknown (capture-failed)");
});

test("a writer that never settles: the decision within the journal cap", async () => {
  const referenceHome = codexHome(GUARDS), home = codexHome(GUARDS);
  const reference = await shell(referenceHome, shellPayload());
  const result = await shell(home, shellPayload(), denialFaultEnv("all-hang", "codex-shell-checks.mts"));
  assert.equal(scrub(result.stdout, home), scrub(reference.stdout, referenceHome));
  assert.ok(result.ms < reference.ms + 1_000 + 2_000, `${result.ms} ms against ${reference.ms} ms`);
});

test("an adapter that does not load: the deny stands and the call leaves the marker", async () => {
  const home = codexHome(GUARDS);
  fs.writeFileSync(path.join(home.hookDir, "hook-adapter.mts"), "");
  const result = await shell(home, shellPayload());
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, /adapter could not load/);
  assert.equal(fs.readFileSync(journalPaths(home.root, "agent-c1").marker, "utf8"), "lib-load\n");
});

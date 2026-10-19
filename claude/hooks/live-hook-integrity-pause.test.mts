// Issue #507, part 2 (L1): the state between the final proof and the heartbeat.
// runIntegrity is paused there through its test seam while this process holds
// the integrity writer's EXCLUSIVE admission, taken from the installation's own
// runtime copy. During the pause a real reader and a real competing writer,
// started through the same entry on the same coordination database, use up
// their whole admission budgets and end busy; the reader's guard never runs and
// the old heartbeat stays. The heartbeat is written only after the pause, still
// under the hold; once the hold ends a fresh reader is admitted.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { cleanup, entry, entryAsync, runtimeHome } from "./hook-runtime-fixture.mts";
import { installIntegrity } from "./integrity-sandbox.mts";
import * as heartbeat from "./lib/integrity-heartbeat.mts";
import * as inventory from "./lib/hook-inventory.mts";
import * as checkout from "./lib/orchestra-checkout.mts";
import * as proof from "./lib/integrity-proof.mts";
import { runIntegrity, type RunLibs, type WriterHold } from "./lib/integrity-run.mts";
import * as syntax from "./lib/hook-syntax.mts";
import * as verdict from "./lib/integrity-verdict.mts";
import * as scope from "./lib/workspace-scope.mts";

const GUARD = "import fs from \"node:fs\";\nfs.writeFileSync(new URL(\"../ran.txt\", import.meta.url), \"ran\\n\");\n";
const PLANTED = "planted\n";
const read = (file: string): string | null => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);

test("L1: between the final proof and the heartbeat the hold admits no reader and no writer", async (t) => {
  delete process.env.KHEREP_WORKSPACE;
  const home = runtimeHome("live-hook-pause-");
  t.after(cleanup);
  installIntegrity(home.hooks);
  const guard = path.join(home.hooks, "guard.mts");
  const writer = path.join(home.hooks, "live-hook-integrity.mts");
  fs.writeFileSync(guard, GUARD);
  const marker = path.join(home.root, "ran.txt");
  const command = (mode: string, main: string): { type: string; command: string } =>
    ({ type: "command", command: `node \${CLAUDE_HOME}/kherep/hook-runtime/entry.mts ${mode} \${CLAUDE_HOME}/hooks/${main}` });
  fs.writeFileSync(path.join(home.root, "settings.json"), JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: "", hooks: [command("reader", "guard.mts")] }],
    SessionStart: [{ hooks: [command("writer", "live-hook-integrity.mts")] }],
  } }));
  const claudeHome = scope.normalizePathLike(home.root);
  const wiring = inventory.wiredFiles(claudeHome);
  assert.deepEqual(wiring.notes, []);
  assert.deepEqual(wiring.uncoordinated, []);
  assert.ok(wiring.files.some((f) => f.rel === "guard.mts"), JSON.stringify(wiring.files));
  const beat = heartbeat.heartbeatFile(claudeHome);
  fs.mkdirSync(path.dirname(beat), { recursive: true });
  fs.writeFileSync(beat, PLANTED);

  const { admit } = await import(pathToFileURL(path.join(home.runtime, "coordinator.mts")).href);
  const hold = await admit({ v: 1, mode: "writer", root: home.hooks, target: writer, deadline: Date.now() + 120_000 }) as WriterHold;
  t.after(() => { try { hold.end(); } catch { /* ended */ } });
  const lib = { ...verdict, ...scope, ...checkout, ...inventory, ...syntax, ...heartbeat, ...proof } as RunLibs;
  const lines: string[] = [];
  const start = Date.now();
  let paused = "no";
  const beforeHeartbeat = async (): Promise<void> => {
    paused = "started";
    assert.equal(hold.holding(), true);
    assert.equal(read(beat), PLANTED);
    const reader = entryAsync("reader", guard);
    const competing = entry("writer", writer, ["--trigger", "test"], "{}", 40_000, { ...process.env, CLAUDE_HOME: home.root });
    assert.equal(competing.status, 1, competing.stdout);
    assert.equal(competing.stderr, "[hook-entry] live-hook-integrity.mts not admitted: busy\n");
    const refused = await reader;
    assert.equal(refused.status, 1, refused.stdout);
    assert.equal(refused.stdout, "");
    assert.equal(refused.stderr, "[hook-entry] guard.mts not admitted: busy\n");
    assert.equal(read(marker), null, "the guard never ran during the hold");
    assert.equal(read(beat), PLANTED, "no heartbeat before the pause ends");
    assert.equal(hold.holding(), true);
    paused = "done";
  };
  await runIntegrity({ lib, hold, gate: "", files: wiring.files, notes: [], lines, payload: {}, home: claudeHome,
    trigger: "pause-test", plain: true, probe: { beforeHeartbeat } });

  assert.equal(paused, "done", "the run waited for the whole pause");
  const ok = /^all (\d+) files OK \(0 restored\), heartbeat refreshed$/.exec(lines.at(-1) ?? "");
  assert.ok(ok, lines.join("\n"));
  const count = Number(ok[1]);
  assert.ok(count > 0);
  assert.equal(hold.holding(), true, "the heartbeat was written under the hold");
  const written = JSON.parse(read(beat)!);
  assert.equal(written.pid, process.pid);
  assert.equal(written.trigger, "pause-test");
  assert.equal(written.files, count);
  assert.ok(Date.parse(written.ts) >= start);
  assert.equal(read(guard), GUARD);
  assert.equal(read(marker), null);

  hold.end();
  const control = entry("reader", guard);
  assert.equal(control.status, 0, control.stderr);
  assert.equal(read(marker), "ran\n");
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  awaitClose, awaitPreloadEvent, awaitPublishedIntent, CRASH_AT_IMPORT_PRELOAD, CRASH_MARKER, describe,
  ensureClosed, HANG_AT_IMPORT_PRELOAD, intentRenamePreload, ownedRoot, preloadEvents, removeWhenClosed,
  startStagedHook, STDIO_HOLDING_HANG_PRELOAD, text,
} from "./mcp-intent-hook-fixture.mts";

// Controls of the staged intent hook fixture (issue #657): each guarantee the
// fixture gives the hook tests is exercised by a real child here.

function hookRoot(t: TestContext) {
  const owned = ownedRoot(t, "kherep-intent-fixture-");
  const configRoot = path.join(owned.root, "config");
  fs.mkdirSync(configRoot);
  return { owned, runs: owned.runs, configRoot, outputRoot: path.join(owned.root, "candidate"),
    clientRoot: path.join(owned.root, "client") };
}

test("the rename preload engages once, on the first rename onto an intent", (t) => {
  const { root } = ownedRoot(t, "kherep-intent-fixture-");
  const script = `import fs from 'node:fs'; import path from 'node:path';
const root = process.argv[1]; const move = (dir) => {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  const temp = path.join(root, dir, '.a.json.tmp'); fs.writeFileSync(temp, '{}');
  fs.renameSync(temp, path.join(root, dir, 'a.json')); };
move('other'); move('intents'); move('intents');`;
  const result = spawnSync(process.execPath, ["--import", intentRenamePreload({ beforeMs: 300 }),
    "--input-type=module", "-e", script, root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const events = result.stderr.split("\n").filter((line) => line.startsWith('{"kherep657"')).map((line) => JSON.parse(line));
  assert.equal(events.length, 2, result.stderr);
  assert.ok(events.every((event) => event.phase === "before" && /[\\/]intents[\\/]a\.json$/.test(event.target)));
  assert.equal(events[1].result, "timed-out", result.stderr);
});

test("a hook that fails at import is reported with its status and stderr, not as a timeout", async (t) => {
  const { outputRoot, clientRoot, configRoot, runs } = hookRoot(t);
  const { run, intents } = startStagedHook({ outputRoot, clientRoot, configRoot, runs,
    preload: [CRASH_AT_IMPORT_PRELOAD] });
  try {
    const outcome = await awaitPublishedIntent(run, intents);
    assert.equal(outcome.kind, "exited", describe(run, outcome));
    assert.notEqual(outcome.code, 0, describe(run, outcome));
    assert.ok(text(run.stderr).includes(CRASH_MARKER), describe(run));
  } finally { await ensureClosed(run); }
});

test("a hook that hangs before publishing hits the bound and is closed before cleanup", async (t) => {
  const { outputRoot, clientRoot, configRoot, runs } = hookRoot(t);
  const { run, intents } = startStagedHook({ outputRoot, clientRoot, configRoot, runs,
    preload: [HANG_AT_IMPORT_PRELOAD] });
  try {
    const outcome = await awaitPublishedIntent(run, intents, { boundMs: 1_000 });
    assert.equal(outcome.kind, "timeout", describe(run, outcome));
    assert.equal(run.close, null, describe(run));
    const close = await ensureClosed(run);
    assert.notEqual(close.code, 0, describe(run));
  } finally { await ensureClosed(run); }
});

test("a hook that hangs after publishing cannot pass the close bound", async (t) => {
  const { outputRoot, clientRoot, configRoot, runs } = hookRoot(t);
  const { run, intents } = startStagedHook({ outputRoot, clientRoot, configRoot, runs,
    preload: [intentRenamePreload({ afterMs: 60_000 })] });
  try {
    const outcome = await awaitPublishedIntent(run, intents);
    assert.equal(outcome.kind, "published", describe(run, outcome));
    const closure = await awaitClose(run, { boundMs: 500 });
    assert.equal(closure.kind, "timeout", describe(run, closure));
    assert.equal(run.close, null, describe(run));
    const close = await ensureClosed(run);
    assert.notEqual(close.code, 0, describe(run));
    assert.ok(preloadEvents(run).some((event) => event.phase === "after" && event.started === true), describe(run));
  } finally { await ensureClosed(run); }
});

test("a hook whose close is not observed keeps its fixture and reports the cleanup failure", async (t) => {
  const { owned, outputRoot, clientRoot, configRoot, runs } = hookRoot(t);
  const { run } = startStagedHook({ outputRoot, clientRoot, configRoot, runs, preload: [STDIO_HOLDING_HANG_PRELOAD] });
  let grandchild = 0;
  try {
    // The grandchild inherits the hook's stdio, so SIGKILL ends the hook but not its pipes.
    const event = await awaitPreloadEvent(run, "grandchild");
    assert.ok(event, describe(run));
    grandchild = Number(event.pid);
    await assert.rejects(ensureClosed(run, { killWaitMs: 500 }), /close not observed/);
    assert.equal(run.close, null, describe(run));
    assert.throws(() => removeWhenClosed(owned), /fixture kept/);
    assert.equal(fs.existsSync(owned.root), true);
  } finally {
    if (grandchild) {
      try { process.kill(grandchild, "SIGKILL"); } catch { /* already gone */ }
    }
    await ensureClosed(run);
  }
});

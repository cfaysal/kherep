// Issue #507, part 2, slow (about 28 s; the cases run in parallel). R6/R7: a
// writer that holds the coordination past the reader's admission budget, and
// a main that never ends, both end in a deny that is printed before Claude
// Code's 30 s cancel. The entry kills the hanging child; its lock ends with it.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";

import { alive, cleanup, entryAsync, holdExclusive, runtimeHome, until, writerFree } from "./hook-runtime-fixture.mts";

after(cleanup);
const reasonOf = (stdout: string): string => JSON.parse(stdout).hookSpecificOutput.permissionDecisionReason;

describe("bounded native PreToolUse runs", { concurrency: true }, () => {
  test("a writer holding EXCLUSIVE past the admission budget: deny, the main never ran", async () => {
    const home = runtimeHome();
    const trace = path.join(home.root, "trace.txt");
    const main = path.join(home.hooks, "main.mts");
    fs.writeFileSync(main, "import fs from \"node:fs\";\nfs.writeFileSync(new URL(\"../trace.txt\", import.meta.url), \"ran\");\n");
    const release = await holdExclusive(home);
    try {
      const run = await entryAsync("pretool", main);
      assert.equal(run.status, 0, run.stderr);
      assert.match(reasonOf(run.stdout), /not admitted: busy/);
      assert.ok(run.ms < 29_000, `took ${run.ms} ms`);
      assert.equal(fs.existsSync(trace), false);
    } finally {
      release();
    }
  });

  test("a main that never ends: deny before the cancel, the child and its lock end", async () => {
    const home = runtimeHome();
    const pidFile = path.join(home.root, "child.pid");
    const main = path.join(home.hooks, "hang.mts");
    fs.writeFileSync(main, "import fs from \"node:fs\";\nfs.writeFileSync(new URL(\"../child.pid\", import.meta.url), String(process.pid));\nsetInterval(() => {}, 1000);\n");
    const run = await entryAsync("pretool", main);
    assert.equal(run.status, 0, run.stderr);
    assert.match(reasonOf(run.stdout), /timed out after \d+ s/);
    assert.ok(run.ms >= 26_000 && run.ms < 29_500, `took ${run.ms} ms`);
    const child = Number(fs.readFileSync(pidFile, "utf8"));
    assert.ok(await until(() => !alive(child), 5000), "the killed child is gone");
    assert.equal(await writerFree(home), true);
  });
});

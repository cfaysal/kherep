// Issue #507, part 2, review of 1dd1ca9 (P1). The runtime admits every process
// of one installation on the database of that installation's hooks root
// (<home>/hooks beside <home>/kherep/hook-runtime), a main or guard in a
// subdirectory of it included. No database is ever derived from a main's own
// directory, so an EXCLUSIVE writer on the root keeps nested mains out too.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { plantHeartbeat } from "./guard-dispatch-fixture.mts";
import { alive, cleanup, entry, entryAsync, holdExclusive, runtimeHome, until, writerFree } from "./hook-runtime-fixture.mts";

after(cleanup);
// Constant program text: each hook names its marker relative to its own place (the home is hooks/..).
const TOP_MAIN = "import fs from \"node:fs\";\nfs.writeFileSync(new URL(\"../top.marker\", import.meta.url), \"executed\");\n";
const NESTED_MAIN = "import fs from \"node:fs\";\nfs.writeFileSync(new URL(\"../../nested.marker\", import.meta.url), \"executed\");\n";

test("a main in a subdirectory waits for the root's writer like a main at the root", async () => {
  const home = runtimeHome();
  fs.mkdirSync(path.join(home.hooks, "sub"));
  const top = path.join(home.root, "top.marker");
  const nested = path.join(home.root, "nested.marker");
  fs.writeFileSync(path.join(home.hooks, "main.mts"), TOP_MAIN);
  fs.writeFileSync(path.join(home.hooks, "sub", "main.mts"), NESTED_MAIN);
  const release = await holdExclusive(home);
  const runs = [entryAsync("pretool", path.join(home.hooks, "main.mts")), entryAsync("pretool", path.join(home.hooks, "sub", "main.mts"))];
  await new Promise((resolve) => setTimeout(resolve, 800));
  const whileExclusive = { topExecuted: fs.existsSync(top), nestedExecuted: fs.existsSync(nested),
    nestedDbCreated: fs.existsSync(path.join(home.hooks, "sub", ".kherep-integrity")) };
  release();
  const done = await Promise.all(runs);
  assert.deepEqual(whileExclusive, { topExecuted: false, nestedExecuted: false, nestedDbCreated: false });
  for (const run of done) assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.existsSync(top) && fs.existsSync(nested), true, "both ran after the release");
  assert.equal(fs.existsSync(path.join(home.hooks, "sub", ".kherep-integrity")), false, "only the root database exists");
});

test("a nested guard under the dispatcher holds the root's database, also when it outlives its parents", async () => {
  const home = runtimeHome();
  fs.mkdirSync(path.join(home.hooks, "sub"));
  fs.copyFileSync(path.join(import.meta.dirname, "guard-dispatch.mts"), path.join(home.hooks, "guard-dispatch.mts"));
  fs.copyFileSync(path.join(import.meta.dirname, "lib", "guard-recheck.mts"), path.join(home.hooks, "lib", "guard-recheck.mts"));
  plantHeartbeat(home.root);
  const go = path.join(home.root, "go");
  const pids = path.join(home.root, "pids");
  fs.writeFileSync(path.join(home.hooks, "sub", "guard.mts"), "import fs from \"node:fs\";\n"
    + "fs.writeFileSync(new URL(\"../../pids\", import.meta.url), JSON.stringify([process.pid, process.ppid]));\n"
    + "while (!fs.existsSync(new URL(\"../../go\", import.meta.url))) await new Promise((r) => setTimeout(r, 20));\n");
  const running = entryAsync("pretool", path.join(home.hooks, "guard-dispatch.mts"), [path.join(home.hooks, "sub", "guard.mts")],
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "true" } }));
  assert.ok(await until(() => fs.existsSync(pids)), "the nested guard was admitted and runs");
  const [guard, dispatcher] = JSON.parse(fs.readFileSync(pids, "utf8")) as number[];
  process.kill(running.pid!, "SIGKILL");
  process.kill(dispatcher!, "SIGKILL");
  await running;
  assert.ok(await until(() => !alive(dispatcher!)));
  if (process.platform === "win32") {
    // A Windows child ends with its parent (libuv's job object): its lock goes only with it.
    assert.ok(await until(() => !alive(guard!)), "the guard ends with its dispatcher");
  } else {
    assert.equal(alive(guard!), true, "the guard outlives its parents");
    assert.equal(await writerFree(home), false, "and still holds the root's database");
    fs.writeFileSync(go, "");
    assert.ok(await until(() => !alive(guard!)), "the guard ends by itself");
  }
  assert.equal(await writerFree(home), true);
  assert.equal(fs.existsSync(path.join(home.hooks, "sub", ".kherep-integrity")), false, "only the root database exists");
});

test("only the root's own live-hook-integrity.mts is a writer, and a main of another installation is refused", () => {
  const home = runtimeHome();
  fs.mkdirSync(path.join(home.hooks, "sub"));
  fs.writeFileSync(path.join(home.hooks, "sub", "live-hook-integrity.mts"), "process.stdout.write(\"ran\");\n");
  const nestedWriter = entry("writer", path.join(home.hooks, "sub", "live-hook-integrity.mts"));
  assert.equal(nestedWriter.stdout, "");
  assert.match(nestedWriter.stderr, /not admitted: mode/);
  const other = runtimeHome();
  fs.writeFileSync(path.join(other.hooks, "main.mts"), "process.stdout.write(\"ran\");\n");
  const foreign = entry("pretool", path.join(other.hooks, "main.mts"), [], "{}", 40_000, process.env, home);
  assert.match(JSON.parse(foreign.stdout).hookSpecificOutput.permissionDecisionReason, /not admitted: main-outside/);
  assert.equal(fs.existsSync(path.join(other.hooks, ".kherep-integrity")), false, "no database beside a foreign main");
});

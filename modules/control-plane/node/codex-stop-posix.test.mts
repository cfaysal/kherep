import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

import { processStart } from "./codex-process.mts";
import { terminate } from "./codex-stop.mts";

// Issue #231 with real processes: like a Codex shell command, the root starts
// a child in its own process group, which the signal to the root's group does
// not reach. The root ends on SIGTERM; the stop still ends the child.
const CHILD = `const c = require("node:child_process").spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
console.log(c.pid);
setInterval(() => {}, 1000);`;

test("a stop ends a child that runs in its own process group (issue #231)",
  { skip: process.platform === "win32" ? "POSIX process groups" : false }, async (t) => {
    const root = spawn(process.execPath, ["-e", CHILD], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const [line] = await once(root.stdout!, "data") as [Buffer];
    const child = Number(line.toString().trim());
    t.after(() => {
      for (const pid of [child, root.pid!]) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already ended
        }
      }
    });
    assert.ok(Number.isInteger(child) && child > 0);
    const childStart = processStart(child);
    assert.notEqual(childStart, null);
    await terminate({ graceMs: 3_000 }, root.pid!, processStart(root.pid!) ?? undefined);
    assert.notEqual(processStart(child), childStart);
  });

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { INSTALL_PAUSE_STALE_MS, installPaused, installPauseFile } from "./install-pause.mts";

// Issue #403: the install lock pauses Claude probing only while it is fresh.
test("no lock, a fresh lock and a stale lock", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-install-pause-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = { dir };
  const now = Date.now();
  assert.equal(installPaused(paths, now), false, "no lock");
  fs.writeFileSync(installPauseFile(paths), "pid=1\n");
  assert.equal(installPaused(paths, now), true, "fresh lock");
  const old = new Date(now - INSTALL_PAUSE_STALE_MS - 60_000);
  fs.utimesSync(installPauseFile(paths), old, old);
  assert.equal(installPaused(paths, now), false, "a 31-minute-old lock is stale");
  const future = new Date(now + INSTALL_PAUSE_STALE_MS + 60_000);
  fs.utimesSync(installPauseFile(paths), future, future);
  assert.equal(installPaused(paths, now), false, "a lock from the far future cannot pause for good");
  fs.rmSync(installPauseFile(paths));
  fs.mkdirSync(installPauseFile(paths));
  assert.equal(installPaused(paths, now), false, "a directory is not the lock");
});

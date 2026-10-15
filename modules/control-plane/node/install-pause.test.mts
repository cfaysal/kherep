import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  INSTALL_PAUSE_STALE_MS, installPaused, installPauseFile, markedProbe, PROBE_MARKER_STALE_MS, probeInFlight, probeMarkerFile,
} from "./install-pause.mts";

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

test("a Claude probe is marked in flight and does not start once the install lock exists", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-install-pause-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = { dir };
  let seen = false;
  assert.deepEqual(await markedProbe(paths, async () => {
    seen = probeInFlight(paths);
    return { ok: true };
  }), { ok: true });
  assert.equal(seen, true, "the marker exists while the probe runs");
  assert.equal(fs.existsSync(probeMarkerFile(paths)), false, "and is removed afterwards");
  fs.writeFileSync(installPauseFile(paths), "pid=1\n");
  let started = false;
  const result = await markedProbe(paths, async () => { started = true; return { ok: true }; });
  assert.equal(started, false, "a lock written before the marker check stops the probe");
  assert.deepEqual(result, { ok: false, cause: "error", detail: "probe deferred: install in progress" });
  assert.equal(fs.existsSync(probeMarkerFile(paths)), false);
  fs.writeFileSync(probeMarkerFile(paths), "1\n");
  const old = new Date(Date.now() - PROBE_MARKER_STALE_MS - 1_000);
  fs.utimesSync(probeMarkerFile(paths), old, old);
  assert.equal(probeInFlight(paths), false, "a marker a crashed daemon left is stale after the probe bound");
});

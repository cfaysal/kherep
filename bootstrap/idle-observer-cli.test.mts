import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const INSTALLER = fileURLToPath(new URL("./idle-observer-install.mts", import.meta.url));
const OBSERVER = fileURLToPath(new URL("../modules/control-plane/node/idle-observer.mts", import.meta.url));

function invoke(args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [INSTALLER, ...args], { encoding: "utf8", windowsHide: true });
}

test("the CLI preserves owner-start verbatim and emits only the fixed status schema", () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".idle-cli-test-"));
  const settings = path.join(root, "settings.json");
  const runDir = path.join(root, "private-run");
  const ownerStart = "Thu Jan 01 00:00:00 2026";
  fs.writeFileSync(settings, "{\"permissions\":{\"allow\":[\"Read\"]}}\n", { mode: 0o600 });
  const target = ["--settings", settings, "--run-dir", runDir];
  try {
    const install = invoke(["install", ...target, "--observer", OBSERVER,
      "--session", "synthetic-session-0001", "--owner-pid", String(process.pid),
      "--owner-start", ownerStart, "--expires-at", new Date(Date.now() + 5 * 60_000).toISOString()]);
    assert.equal(install.status, 0, install.stderr);
    assert.deepEqual(Object.keys(JSON.parse(install.stdout) as object).sort(),
      ["activation", "idleValid", "lastSequence", "observationCount", "ok", "ownedEntries", "status"].sort());
    const run = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8")) as { owner: { startedAt: string } };
    assert.equal(run.owner.startedAt, ownerStart);

    const status = invoke(["status", ...target]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal((JSON.parse(status.stdout) as { status: string }).status, "installed");
    assert.equal(status.stdout.includes(settings), false);
    assert.equal(status.stdout.includes(runDir), false);

    const remove = invoke(["remove", ...target]);
    assert.equal(remove.status, 0, remove.stderr);
    assert.equal((JSON.parse(remove.stdout) as { status: string }).status, "removed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

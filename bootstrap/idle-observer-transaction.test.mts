import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { observeEvent } from "../modules/control-plane/node/idle-observer.mts";
import { installObservation, observationStatus, removeObservation, type InstallOptions } from "./idle-observer-install.mts";

test("receipt finalization failure rolls settings back without orphaning owned hooks", () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".idle-transaction-test-"));
  const settingsFile = path.join(root, "settings.json");
  const runDir = path.join(root, "private-run");
  const observerFile = fileURLToPath(new URL("../modules/control-plane/node/idle-observer.mts", import.meta.url));
  const before = `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "existing" }] }] } }, null, 2)}\n`;
  fs.writeFileSync(settingsFile, before, { mode: 0o600 });
  const options: InstallOptions = {
    settingsFile, runDir, observerFile, sessionId: "synthetic-session-0001",
    owner: { pid: 4242, startedAt: "synthetic-generation-1" },
    expiresAt: "2026-10-15T09:09:00.000Z",
  };
  try {
    const result = installObservation(options, {
      now: () => new Date("2026-10-15T09:00:00.000Z"), randomHex: () => "b".repeat(64),
      nodePath: "synthetic-node", finalizeReceipt: () => {
        const changed = JSON.parse(fs.readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
        changed.unrelated = "preserved";
        fs.writeFileSync(settingsFile, `${JSON.stringify(changed, null, 2)}\n`, { mode: 0o600 });
        throw new Error("synthetic receipt failure");
      },
    });
    assert.deepEqual(result, { ok: false, status: "refused", code: "INTERNAL_ERROR" });
    assert.equal(fs.readFileSync(settingsFile, "utf8").includes("--run-id"), true);
    const prepared = JSON.parse(fs.readFileSync(path.join(runDir, "install-receipt.json"), "utf8")) as { state: string };
    assert.equal(prepared.state, "prepared");
    assert.equal(observationStatus({ settingsFile, runDir }).status, "refused");
    assert.equal(removeObservation({ settingsFile, runDir }).status, "removed");
    const cleaned = JSON.parse(fs.readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
    assert.equal(cleaned.unrelated, "preserved");
    assert.equal(fs.readFileSync(settingsFile, "utf8").includes("--run-id"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed activity write cannot leave an earlier idle status positive", () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".idle-activity-failure-test-"));
  const settingsFile = path.join(root, "settings.json");
  const runDir = path.join(root, "private-run");
  const observerFile = fileURLToPath(new URL("../modules/control-plane/node/idle-observer.mts", import.meta.url));
  fs.writeFileSync(settingsFile, "{}\n", { mode: 0o600 });
  const now = new Date();
  const owner = { pid: 4242, startedAt: "synthetic-generation-1" };
  try {
    assert.equal(installObservation({ settingsFile, runDir, observerFile, sessionId: "synthetic-session-0001",
      owner, expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString() }).status, "installed");
    const run = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8")) as {
      armNonce: string; codeSha256: string;
    };
    const base = { session_id: "synthetic-session-0001", hook_event_name: "Notification", notification_type: "idle_prompt" };
    const deps = { now: () => now, ancestry: () => [owner], codeSha256: () => run.codeSha256 };
    assert.equal(observeEvent(runDir, run.armNonce, base, deps), "recorded");
    assert.equal(observeEvent(runDir, run.armNonce, { ...base, hook_event_name: "SessionStart",
      notification_type: undefined }, { ...deps, activityWrite(fd: number) {
      fs.writeSync(fd, "{partial", 0, "utf8"); throw new Error("synthetic write failure");
    } }), "ignored");
    assert.deepEqual(observationStatus({ settingsFile, runDir }, { now: () => now, ownerIdentity: () => owner }),
      { ok: false, status: "refused", code: "INVALID_ACTIVITY_WITNESS" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

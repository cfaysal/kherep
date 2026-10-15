import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  observeEvent,
  type ObservationDeps,
  type ObservationJournal,
  type ObservationRun,
} from "./idle-observer.mts";
import { createPrivateDirectory, ownedPath, writePrivateNew } from "../../../bootstrap/idle-observer-storage.mts";
const NOW = "2026-10-15T09:00:00.000Z";
const OWNER = { pid: 4242, startedAt: "owner-generation-1" };
const CODE = "a".repeat(64);
const ARM = "b".repeat(64);
function fixture(overrides: Partial<ObservationRun> = {}): { dir: string; run: ObservationRun } {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".idle-observer-test-"));
  fs.rmSync(dir, { recursive: true });
  createPrivateDirectory(dir);
  const run: ObservationRun = {
    version: 1,
    runId: "synthetic-run-0001",
    sessionId: "synthetic-session-0001",
    armNonce: ARM,
    createdAt: "2026-10-15T08:59:00.000Z",
    expiresAt: "2026-10-15T09:09:00.000Z",
    owner: OWNER,
    codeSha256: CODE,
    ...overrides,
  };
  writePrivateNew(path.join(dir, "run.json"), `${JSON.stringify(run)}\n`);
  return { dir, run };
}
function deps(overrides: Partial<ObservationDeps> = {}): ObservationDeps {
  return {
    now: () => new Date(NOW),
    ancestry: () => [OWNER, { pid: 41, startedAt: "parent-generation" }],
    codeSha256: () => CODE,
    ...overrides,
  };
}
function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: "synthetic-session-0001",
    hook_event_name: "Notification",
    notification_type: "idle_prompt",
    ...overrides,
  };
}
function journal(dir: string): ObservationJournal | null {
  const file = path.join(dir, "journal.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as ObservationJournal : null;
}
test("records one fresh native idle receipt for the exact session and owner generation", () => {
  const { dir, run } = fixture();
  try {
    assert.equal(observeEvent(dir, ARM, event(), deps()), "recorded");
    assert.deepEqual(journal(dir), {
      version: 1,
      runId: run.runId,
      events: [{
        runId: run.runId,
        event: "Notification",
        notificationType: "idle_prompt",
        receivedAt: NOW,
        owner: OWNER,
        codeSha256: CODE,
        sequence: 1,
      }],
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("rejects foreign, unknown, reused, expired, future, malformed and wrong-event input", async (t) => {
  const cases: Array<[string, Partial<ObservationRun>, Record<string, unknown>, Partial<ObservationDeps>]> = [
    ["foreign session", {}, event({ session_id: "synthetic-session-foreign" }), {}],
    ["unknown ancestry", {}, event(), { ancestry: () => null }],
    ["foreign ancestry", {}, event(), { ancestry: () => [{ pid: 99, startedAt: "other" }] }],
    ["PID reuse", {}, event(), { ancestry: () => [{ ...OWNER, startedAt: "owner-generation-2" }] }],
    ["expired", { expiresAt: "2026-10-15T08:59:59.000Z" }, event(), {}],
    ["future", { createdAt: "2026-10-15T09:00:01.000Z" }, event(), {}],
    ["wrong event", {}, event({ hook_event_name: "Stop" }), {}],
    ["wrong notification", {}, event({ notification_type: "permission_prompt" }), {}],
    ["wrong code", {}, event(), { codeSha256: () => "c".repeat(64) }],
  ];
  for (const [name, runOverrides, input, depOverrides] of cases) await t.test(name, () => {
    const { dir } = fixture(runOverrides);
    try {
      assert.equal(observeEvent(dir, ARM, input, deps(depOverrides)), "ignored");
      assert.equal(journal(dir), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  const { dir } = fixture();
  try {
    fs.writeFileSync(path.join(dir, "run.json"), "{malformed", { mode: 0o600 });
    assert.equal(observeEvent(dir, ARM, event(), deps()), "ignored");
    assert.equal(journal(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("stores no raw hook fields and never duplicates the idle receipt", () => {
  const { dir } = fixture();
  const canaries = {
    message: "CANARY-message",
    title: "CANARY-title",
    cwd: "CANARY-cwd",
    transcript_path: "CANARY-transcript",
    prompt: "CANARY-prompt",
    tool_input: { secret: "CANARY-tool-input" },
    tool_output: "CANARY-tool-output",
  };
  try {
    assert.equal(observeEvent(dir, ARM, event(canaries), deps()), "recorded");
    assert.equal(observeEvent(dir, ARM, event(canaries), deps()), "ignored");
    const stored = fs.readFileSync(path.join(dir, "journal.json"), "utf8");
    assert.equal(journal(dir)?.events.length, 1);
    for (const value of Object.values(canaries).flatMap((v) => typeof v === "string" ? [v] : Object.values(v))) {
      assert.equal(stored.includes(String(value)), false);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("target activity invalidates the idle receipt and advances the sequence", () => {
  const { dir } = fixture();
  try {
    assert.equal(observeEvent(dir, ARM, event(), deps()), "recorded");
    assert.equal(observeEvent(dir, ARM, event({ hook_event_name: "UserPromptSubmit", notification_type: undefined }), deps()), "recorded");
    assert.equal(observeEvent(dir, ARM, event({ hook_event_name: "SessionStart", notification_type: undefined }), deps()), "recorded");
    assert.deepEqual(journal(dir)?.events.map(({ event: name, sequence }) => ({ name, sequence })), [
      { name: "Notification", sequence: 1 },
      { name: "UserPromptSubmit", sequence: 2 },
      { name: "SessionStart", sequence: 3 },
    ]);
    assert.equal(journal(dir)?.events.at(-1)?.event, "SessionStart");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("journal capacity preserves the first idle receipt as a one-shot marker", () => {
  const { dir } = fixture();
  const activity = event({ hook_event_name: "UserPromptSubmit", notification_type: undefined });
  try {
    assert.equal(observeEvent(dir, ARM, event(), deps()), "recorded");
    for (let index = 0; index < 16; index++) {
      assert.equal(observeEvent(dir, ARM, activity, deps()), "recorded");
    }
    assert.equal(journal(dir)?.events.length, 16);
    assert.equal(journal(dir)?.events[0]?.event, "Notification");
    assert.equal(observeEvent(dir, ARM, event(), deps()), "ignored");
    assert.equal(journal(dir)?.events.filter((item) => item.event === "Notification").length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("rejects a symlinked run contract", (t) => {
  const { dir } = fixture();
  const target = path.join(dir, "target.json");
  try {
    try {
      fs.renameSync(path.join(dir, "run.json"), target);
      fs.symlinkSync(target, path.join(dir, "run.json"), "file");
    } catch (error) {
      t.skip(`symlink unavailable: ${(error as NodeJS.ErrnoException).code ?? "unknown"}`);
      return;
    }
    assert.equal(observeEvent(dir, ARM, event(), deps()), "ignored");
    assert.equal(journal(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("a competing callback lock fails closed without removing the owner's lock", () => {
  const { dir } = fixture();
  const lock = path.join(dir, ".observer.lock");
  try {
    fs.writeFileSync(lock, "held", { mode: 0o600 });
    assert.equal(observeEvent(dir, ARM, event(), deps()), "ignored");
    assert.equal(fs.readFileSync(lock, "utf8"), "held");
    assert.equal(journal(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("activity contention leaves a durable invalidation witness", () => {
  const { dir } = fixture();
  const lock = path.join(dir, ".observer.lock");
  try {
    assert.equal(observeEvent(dir, ARM, event(), deps()), "recorded");
    fs.writeFileSync(lock, "held", { mode: 0o600 });
    assert.equal(observeEvent(dir, ARM,
      event({ hook_event_name: "UserPromptSubmit", notification_type: undefined }), deps()), "recorded");
    assert.equal(journal(dir)?.events.at(-1)?.event, "Notification");
    assert.equal(fs.readdirSync(dir).some((name) => /^activity-\d\d\.json$/.test(name)), true);
    assert.equal(fs.readFileSync(lock, "utf8"), "held");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("a partial activity write remains as fail-closed evidence", () => {
  const { dir } = fixture();
  try {
    assert.equal(observeEvent(dir, ARM, event(), deps()), "recorded");
    const beforeContent = observeEvent(dir, ARM,
      event({ hook_event_name: "SessionStart", notification_type: undefined }), deps({
        activityPrepare() { throw new Error("synthetic security failure"); },
      }));
    assert.equal(beforeContent, "ignored");
    assert.equal(fs.existsSync(path.join(dir, "activity-00.json")), true);
    assert.equal(fs.statSync(path.join(dir, "activity-00.json")).size, 0);
    const result = observeEvent(dir, ARM,
      event({ hook_event_name: "SessionStart", notification_type: undefined }), deps({ activityPrepare(file) {
        if (process.platform !== "win32") return;
        const script = "$p=$env:KHEREP_TEST_PATH;$i=New-Object IO.FileInfo -ArgumentList $p;$a=$i.GetAccessControl();"
          + "$s=([Security.Principal.NTAccount]'NT AUTHORITY\\SYSTEM').Translate([Security.Principal.SecurityIdentifier]);"
          + "$r=New-Object Security.AccessControl.FileSystemAccessRule($s,'Read','Allow');$a.AddAccessRule($r);$i.SetAccessControl($a)";
        assert.equal(spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
          { env: { ...process.env, KHEREP_TEST_PATH: file }, stdio: "ignore" }).status, 0);
      },
        activityWrite(fd) {
          assert.equal(ownedPath(path.join(dir, "activity-01.json"), "file", true), true);
          assert.equal(fs.statSync(path.join(dir, "activity-01.json")).size, 0);
          fs.writeSync(fd, "{partial", 0, "utf8");
          throw new Error("synthetic activity write failure");
        },
      }));
    assert.equal(result, "ignored");
    assert.equal(fs.readFileSync(path.join(dir, "activity-01.json"), "utf8"), "{partial");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("the command callback is silent and exits zero for malformed input", () => {
  const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning",
    fileURLToPath(new URL("./idle-observer.mts", import.meta.url)), "callback"], {
    input: "{malformed", encoding: "utf8", windowsHide: true,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

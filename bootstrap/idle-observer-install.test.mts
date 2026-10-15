import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  installObservation,
  observationStatus,
  removeObservation,
  type InstallOptions,
  type InstallerDeps,
} from "./idle-observer-install.mts";

const NOW = "2026-10-15T09:00:00.000Z";
const OBSERVER = fileURLToPath(new URL("../modules/control-plane/node/idle-observer.mts", import.meta.url));
const CANARY_PATH = "SYNTHETIC-private-path-canary";

function fixture(settings: unknown = baseSettings()): { root: string; settings: string; runDir: string } {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".idle-install-test-"));
  const settingsFile = path.join(root, "settings.json");
  fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return { root, settings: settingsFile, runDir: path.join(root, "private-run") };
}

function baseSettings(): Record<string, unknown> {
  return {
    env: { KEEP: CANARY_PATH },
    permissions: { allow: ["Read"], defaultMode: "default" },
    custom: { preserved: true },
    hooks: {
      Notification: [{ matcher: "permission_prompt", hooks: [{ type: "command", command: "existing", args: ["safe"] }] }],
      Stop: [{ hooks: [{ type: "command", command: "existing-stop" }] }],
    },
  };
}

function options(f: { settings: string; runDir: string }): InstallOptions {
  return {
    settingsFile: f.settings,
    runDir: f.runDir,
    observerFile: OBSERVER,
    sessionId: "synthetic-session-0001",
    owner: { pid: 4242, startedAt: "synthetic-generation-1" },
    expiresAt: "2026-10-15T09:09:00.000Z",
  };
}

function deps(): InstallerDeps {
  return { now: () => new Date(NOW), randomHex: () => "b".repeat(64), nodePath: "synthetic-node" };
}

function read(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

function allHandlers(settings: Record<string, unknown>): Record<string, unknown>[] {
  const hooks = settings.hooks as Record<string, Array<{ hooks?: Record<string, unknown>[] }>>;
  return Object.values(hooks).flatMap((groups) => groups.flatMap((group) => group.hooks ?? []));
}

function ownedHandlers(settings: Record<string, unknown>): Record<string, unknown>[] {
  return allHandlers(settings).filter((handler) => Array.isArray(handler.args)
    && (handler.args as unknown[]).includes("--run-id"));
}

test("install adds only three task-bound handlers and preserves all existing settings", () => {
  const f = fixture();
  const before = fs.readFileSync(f.settings, "utf8");
  try {
    const result = installObservation(options(f), deps());
    assert.deepEqual(result, {
      ok: true, status: "installed", ownedEntries: 3, observationCount: 0,
      lastSequence: 0, idleValid: false, activation: "unproven",
    });
    const after = read(f.settings);
    assert.deepEqual(after.env, (baseSettings()).env);
    assert.deepEqual(after.permissions, (baseSettings()).permissions);
    assert.deepEqual(after.custom, (baseSettings()).custom);
    assert.equal((after.hooks as Record<string, unknown[]>).Stop.length, 1);
    assert.equal(ownedHandlers(after).length, 3);
    assert.deepEqual(Object.keys(after.hooks as object).sort(), ["Notification", "SessionStart", "Stop", "UserPromptSubmit"]);
    assert.equal(fs.readFileSync(path.join(f.runDir, "settings.backup"), "utf8"), before);

    const notification = ((after.hooks as Record<string, Array<Record<string, unknown>>>).Notification)
      .find((entry) => entry.matcher === "^idle_prompt$");
    assert.equal(notification?.matcher, "^idle_prompt$");
    const own = ownedHandlers(after);
    assert.equal(own.some((entry) => "async" in entry || "asyncRewake" in entry), false);
    assert.equal(JSON.stringify(own).includes("additionalContext"), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("install and remove are idempotent, and removal preserves unrelated intervening edits", () => {
  const f = fixture();
  try {
    assert.equal(installObservation(options(f), deps()).status, "installed");
    assert.equal(installObservation(options(f), deps()).status, "already-installed");
    assert.equal(ownedHandlers(read(f.settings)).length, 3);

    const edited = read(f.settings);
    (edited.env as Record<string, unknown>).LATER = "unrelated";
    const hooks = edited.hooks as Record<string, Array<Record<string, unknown>>>;
    hooks.Notification.push({ matcher: "auth_success", hooks: [{ type: "command", command: "later" }] });
    fs.writeFileSync(f.settings, `${JSON.stringify(edited, null, 2)}\n`, { mode: 0o600 });

    assert.equal(removeObservation({ settingsFile: f.settings, runDir: f.runDir }).status, "removed");
    const removed = read(f.settings);
    assert.equal((removed.env as Record<string, unknown>).LATER, "unrelated");
    assert.equal(JSON.stringify(removed).includes("auth_success"), true);
    assert.equal(ownedHandlers(removed).length, 0);
    assert.equal(removeObservation({ settingsFile: f.settings, runDir: f.runDir }).status, "already-removed");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("remove refuses owned-entry drift without modifying the settings file", () => {
  const f = fixture();
  try {
    installObservation(options(f), deps());
    const settings = read(f.settings);
    ownedHandlers(settings)[0]!.command = "drifted-command";
    fs.writeFileSync(f.settings, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    const beforeRemove = fs.readFileSync(f.settings, "utf8");
    assert.deepEqual(removeObservation({ settingsFile: f.settings, runDir: f.runDir }), {
      ok: false, status: "refused", code: "OWNED_ENTRY_DRIFT",
    });
    assert.equal(fs.readFileSync(f.settings, "utf8"), beforeRemove);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("status reports only fixed safe metadata and activity invalidates idle validity", () => {
  const f = fixture();
  try {
    installObservation(options(f), deps());
    const run = read(path.join(f.runDir, "run.json"));
    fs.writeFileSync(path.join(f.runDir, "journal.json"), `${JSON.stringify({
      version: 1, runId: run.runId,
      events: [
        { runId: run.runId, event: "Notification", notificationType: "idle_prompt", receivedAt: NOW,
          owner: run.owner, codeSha256: run.codeSha256, sequence: 1 },
        { runId: run.runId, event: "UserPromptSubmit", receivedAt: NOW,
          owner: run.owner, codeSha256: run.codeSha256, sequence: 2 },
      ],
    })}\n`, { mode: 0o600 });
    const result = observationStatus({ settingsFile: f.settings, runDir: f.runDir });
    assert.deepEqual(result, {
      ok: true, status: "installed", ownedEntries: 3, observationCount: 2,
      lastSequence: 2, idleValid: false, activation: "unproven",
    });
    const output = JSON.stringify(result);
    assert.equal(output.includes(f.settings), false);
    assert.equal(output.includes(f.runDir), false);
    assert.equal(output.includes(CANARY_PATH), false);
    assert.equal(output.includes("command"), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("status requires an unexpired run and the current owner generation", () => {
  const f = fixture();
  try {
    installObservation(options(f), deps());
    const run = read(path.join(f.runDir, "run.json"));
    fs.writeFileSync(path.join(f.runDir, "journal.json"), `${JSON.stringify({
      version: 1, runId: run.runId,
      events: [{ runId: run.runId, event: "Notification", notificationType: "idle_prompt",
        receivedAt: NOW, owner: run.owner, codeSha256: run.codeSha256, sequence: 1 }],
    })}\n`, { mode: 0o600 });
    const target = { settingsFile: f.settings, runDir: f.runDir };
    const expired = observationStatus(target, {
      now: () => new Date("2026-10-15T09:10:00.000Z"), ownerIdentity: () => options(f).owner,
    });
    assert.equal(expired.ok && expired.idleValid, false);
    const reused = observationStatus(target, {
      now: () => new Date(NOW), ownerIdentity: () => ({ ...options(f).owner, startedAt: "reused-generation" }),
    });
    assert.equal(reused.ok && reused.idleValid, false);
    const valid = observationStatus(target, {
      now: () => new Date(NOW), ownerIdentity: () => options(f).owner,
    });
    assert.equal(valid.ok && valid.idleValid, true);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("a contended activity witness invalidates an otherwise latest idle receipt", () => {
  const f = fixture();
  try {
    installObservation(options(f), deps());
    const run = read(path.join(f.runDir, "run.json"));
    fs.writeFileSync(path.join(f.runDir, "journal.json"), `${JSON.stringify({
      version: 1, runId: run.runId,
      events: [{ runId: run.runId, event: "Notification", notificationType: "idle_prompt",
        receivedAt: NOW, owner: run.owner, codeSha256: run.codeSha256, sequence: 1 }],
    })}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(f.runDir, "activity-00.json"), `${JSON.stringify({
      runId: run.runId, event: "UserPromptSubmit", receivedAt: NOW,
      owner: run.owner, codeSha256: run.codeSha256, sequence: 2,
    })}\n`, { mode: 0o600 });
    const status = observationStatus({ settingsFile: f.settings, runDir: f.runDir }, {
      now: () => new Date(NOW), ownerIdentity: () => options(f).owner,
    });
    assert.equal(status.ok && status.idleValid, false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("malformed, expired and symlink targets fail closed without changing input", async (t) => {
  await t.test("malformed settings", () => {
    const f = fixture("malformed-shape");
    try {
      const before = fs.readFileSync(f.settings, "utf8");
      assert.deepEqual(installObservation(options(f), deps()), { ok: false, status: "refused", code: "INVALID_SETTINGS" });
      assert.equal(fs.readFileSync(f.settings, "utf8"), before);
      assert.equal(fs.existsSync(f.runDir), false);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  await t.test("lifetime beyond ten minutes", () => {
    const f = fixture();
    try {
      assert.deepEqual(installObservation({ ...options(f), expiresAt: "2026-10-15T09:10:00.001Z" }, deps()),
        { ok: false, status: "refused", code: "INVALID_EXPIRY" });
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  await t.test("symlinked settings", (st) => {
    const f = fixture();
    const link = path.join(f.root, "settings-link.json");
    try {
      try { fs.symlinkSync(f.settings, link, "file"); } catch (error) {
        st.skip(`symlink unavailable: ${(error as NodeJS.ErrnoException).code ?? "unknown"}`); return;
      }
      assert.deepEqual(installObservation({ ...options(f), settingsFile: link }, deps()),
        { ok: false, status: "refused", code: "UNSAFE_TARGET" });
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
});

import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { defaultServiceName, parseServiceCommand, runService, safeServiceFailure } from "./service-cli.mts";
import type { ServiceAdapter, ServiceBinding } from "./service-types.mts";

test("service install parses an explicit adopted nested Windows task", () => {
  const workspace = path.resolve("workspace");
  const source = path.resolve("source");
  assert.deepEqual(parseServiceCommand(["install", "--workspace", workspace, "--source", source,
    "--service-name", "Node", "--task-path", "\\Kherep\\", "--adopt"]),
  { action: "install", workspace, source, serviceName: "Node", taskPath: "\\Kherep\\", adopt: true, explicitServiceName: true });
  assert.deepEqual(parseServiceCommand(["install", "--workspace", workspace, "--service-name", "\\Kherep\\Node", "--adopt"]),
    { action: "install", workspace, serviceName: "\\Kherep\\Node", adopt: true, explicitServiceName: true });
});

test("fresh services use neutral platform defaults", () => {
  assert.equal(defaultServiceName("darwin"), "org.kherep.node");
  assert.equal(defaultServiceName("win32"), "KherepNode");
});

test("service failures expose only a fixed code and measured recovery", () => {
  const raw = "private native stderr with environment and definition";
  const report = safeServiceFailure({ code: "SERVICE_ACTIVATION_FAILED", recovery: "unknown", message: raw });
  assert.deepEqual(report, { ok: false, code: "SERVICE_ACTIVATION_FAILED", recovery: "unknown" });
  assert.equal(JSON.stringify(report).includes(raw), false);
  assert.equal(safeServiceFailure({ code: "EPERM", recovery: "unknown", message: raw }), null);
});

test("service upgrade, status and rollback refuse options outside their contract", () => {
  const source = path.resolve("source");
  assert.deepEqual(parseServiceCommand(["upgrade", "--source", source]), { action: "upgrade", source });
  assert.deepEqual(parseServiceCommand(["status"]), { action: "status" });
  assert.deepEqual(parseServiceCommand(["rollback"]), { action: "rollback" });
  assert.throws(() => parseServiceCommand(["upgrade", "--workspace", path.resolve("work")]), /usage/);
  assert.throws(() => parseServiceCommand(["status", "--adopt"]), /usage/);
  assert.throws(() => parseServiceCommand(["install"]), /workspace/);
});

test("service status rejects stopped, unauthenticated and foreign recorded daemons", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-service-status-"));
  const source = { root: path.join(root, "source"), commit: "a".repeat(40), digest: "b".repeat(64), kind: "pin" as const, verified: true };
  const binding: ServiceBinding = { platform: "win32", serviceName: "Node", taskPath: "\\Kherep", workspace: path.join(root, "work"),
    configRoot: root, nodeExecutable: process.execPath, source };
  const snapshot = { definition: Buffer.from("definition"), security: Buffer.from("security"), running: true as boolean | "unknown" };
  const adapter = { read: async () => snapshot, processOwned: async () => true } as unknown as ServiceAdapter;
  const receipt = { version: 1 as const, binding, definitionDigest: "520f405f734935644a2693e5d17cf1f92d0af54d4b75e3d5d4f32d29476842f9",
    securityDigest: "5d2d3ceb7abe552344276d47d36a8175b7aeb250a9bf0bf00e3b787df649abb5", activatedAt: new Date().toISOString() };
  const connected = { pid: 1234, startedAt: "2026-10-14T18:00:00.000Z", connectedAt: "2026-10-14T18:00:01.000Z", source,
    service: { name: binding.serviceName, platform: binding.platform, taskPath: binding.taskPath } };
  const cases = [
    { name: "stopped", running: false as const, state: connected, alive: true, owned: true },
    { name: "lost authentication", running: true as const, state: { ...connected, disconnectedAt: "2026-10-14T18:00:02.000Z" }, alive: true, owned: true },
    { name: "foreign reused pid", running: true as const, state: connected, alive: true, owned: false },
  ];
  const originalLog = console.log;
  try {
    for (const item of cases) {
      snapshot.running = item.running;
      adapter.processOwned = async () => item.owned;
      let output = "";
      console.log = value => { output = String(value); };
      const exit = await runService(["status"], { root, readReceipt: () => receipt, adapterFor: () => adapter,
        readState: () => item.state, alive: () => item.alive });
      assert.equal(exit, 1, item.name);
      const report = JSON.parse(output) as Record<string, unknown>;
      assert.equal(report.ok, false, item.name);
      assert.equal("pid" in report, false, `${item.name} must not expose a pid`);
    }
  } finally {
    console.log = originalLog;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

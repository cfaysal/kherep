import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { decodeSupervisorBinding, encodeSupervisorBinding } from "./service-supervisor-data.mts";
import {
  RESTART_DELAY_MS, openSupervisorLog, startWindowsServiceSupervisor, validateSupervisorRuntime,
} from "./service-supervisor.mts";
import type { ServiceBinding } from "./service-types.mts";

const source = { root: String.raw`C:\Pins\source`, commit: "a".repeat(40), digest: "b".repeat(64),
  kind: "pin" as const, verified: true };
const binding: ServiceBinding = { serviceName: "Kherep Node", taskPath: "\\Kherep\\", platform: "win32",
  workspace: String.raw`C:\Workspace`, configRoot: String.raw`C:\Config`, nodeExecutable: String.raw`C:\Node\node.exe`,
  logFile: String.raw`C:\Logs\daemon.log`, supervisorGeneration: "22222222-2222-4222-8222-222222222222", source };

test("supervisor payload accepts only bounded service binding data", () => {
  const encoded = encodeSupervisorBinding(binding);
  assert.deepEqual(decodeSupervisorBinding(encoded), binding);
  const foreign = Buffer.from(JSON.stringify({ version: 1, binding, command: "cmd.exe" })).toString("base64");
  assert.throws(() => decodeSupervisorBinding(foreign), /payload schema/);
  assert.throws(() => decodeSupervisorBinding("A".repeat(20_000)), /payload size/);
  assert.throws(() => encodeSupervisorBinding({ ...binding, logFile: undefined }), /log file/);
});

test("supervisor runtime rejects source, executable, and inherited Node environment drift", () => {
  const runtime = { nodeExecutable: binding.nodeExecutable, sourceRoot: binding.source.root, env: { LANG: "C" },
    captureSource: () => binding.source };
  assert.doesNotThrow(() => validateSupervisorRuntime(binding, runtime));
  assert.throws(() => validateSupervisorRuntime(binding, { ...runtime, env: { Node_Options: "--import=foreign" } }),
    /execution-affecting/);
  assert.throws(() => validateSupervisorRuntime(binding, { ...runtime, nodeExecutable: String.raw`C:\Other\node.exe` }),
    /Node executable/);
  assert.throws(() => validateSupervisorRuntime(binding, { ...runtime,
    captureSource: () => ({ ...binding.source, digest: "c".repeat(64) }) }), /source identity/);
});

test("supervisor requires its one-use permit for an initial start under drain and waits before restart", async () => {
  class Child extends EventEmitter { killCalls = 0; kill() { this.killCalls++; return true; } }
  const children: Child[] = [];
  const sleeps: number[] = [];
  const drains = [true, true, false];
  const permits = [true, false];
  const spawns: Array<{ executable: string; args: string[]; options: Record<string, unknown> }> = [];
  let verifies = 0;
  const supervisor = startWindowsServiceSupervisor(binding, {
    openLog: () => 77,
    closeLog: () => {},
    reportStartFailure: () => {},
    verifySource: () => { verifies++; },
    drainActive: () => drains.shift() ?? false,
    claimPermit: () => permits.shift() ?? false,
    sleep: async milliseconds => { sleeps.push(milliseconds); },
    spawnChild: (executable, args, options) => {
      spawns.push({ executable, args, options: options as Record<string, unknown> });
      const child = new Child(); children.push(child); return child;
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(spawns.length, 1, "the first child uses the exact transaction permit while the drain exists");
  assert.deepEqual(spawns[0].options.stdio, ["ignore", 77, 77]);
  assert.equal(spawns[0].options.shell, false);
  assert.equal(spawns[0].options.detached, false);
  children[0].emit("error", new Error("synthetic"));
  children[0].emit("close", 7);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(spawns.length, 2, "error plus close schedules only one replacement");
  assert.deepEqual(sleeps, [RESTART_DELAY_MS, 100]);
  assert.equal(verifies, 2, "the immutable source is checked before every child start");
  await supervisor.stop();
});

test("supervisor log is append-only and rejects a non-regular target", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-supervisor-log-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "daemon.log");
  fs.writeFileSync(file, "before\n");
  const fd = openSupervisorLog(file);
  fs.writeSync(fd, "after\n");
  fs.closeSync(fd);
  assert.equal(fs.readFileSync(file, "utf8"), "before\nafter\n");
  assert.throws(() => openSupervisorLog(root), /regular file/);
});

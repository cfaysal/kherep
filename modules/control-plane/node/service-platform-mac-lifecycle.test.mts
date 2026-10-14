import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { nodePaths } from "./config.mts";
import { managedArguments } from "./service-definitions.mts";
import { removeFresh, restorePrior } from "./service-lifecycle.mts";
import { MacServiceAdapter } from "./service-platform-mac.mts";
import type { MacCommand, MacCommandResult } from "./service-platform-mac-native.mts";
import type { ServiceBinding } from "./service-types.mts";

const label = "org.kherep.synthetic";
const result = (status: number, stdout = "", stderr = ""): MacCommandResult => ({ status, stdout, stderr });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-mac-lifecycle-"));
  const home = path.join(root, "home");
  const file = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "CANDIDATE_PLIST", { mode: 0o600 });
  const stat = fs.lstatSync(file);
  const sourceRoot = path.join(root, "source");
  const binding: ServiceBinding = {
    serviceName: label, platform: "darwin", workspace: root, configRoot: path.join(root, "config"),
    nodeExecutable: path.join(root, "node"),
    source: { root: sourceRoot, commit: "a".repeat(40), digest: "b".repeat(64), kind: "pin", verified: true },
  };
  const mac = { Label: label, ProgramArguments: [binding.nodeExecutable, ...managedArguments(binding)] };
  return { root, home, file, stat, binding, mac };
}

function absentRunner(
  uid: number, mac: Record<string, unknown>, calls: string[],
  inventory: MacCommandResult = result(0, "123 999 /usr/bin/synthetic-unrelated\n"),
): MacCommand {
  return (file, args) => {
    calls.push([file, ...args].join(" "));
    if (file === "launchctl" && args[0] === "print" && args[1] === `gui/${uid}/${label}`) {
      return result(113, "", `Bad request.\nCould not find service "${label}" in domain for user gui: ${uid}\n`);
    }
    if (file === "launchctl" && args[0] === "print" && args[1] === `gui/${uid}`) {
      return result(0, `gui/${uid} = {\n}\n`);
    }
    if (file === "plutil") return result(0, JSON.stringify(mac));
    if (file === "/bin/ls") return result(0, "-rw------- 1 operator staff 1 Oct 14 10:00 service.plist\n");
    if (file === "ps" && args[0] === "-ww" && args[1] === "-axo") return inventory;
    return result(1, "", "unexpected synthetic command");
  };
}

test("failed bootstrap cleanup removes a fresh definition only after complete process absence", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const calls: string[] = [];
  const adapter = new MacServiceAdapter(path.join(f.root, "service"), f.home, f.stat.uid, f.stat.gid,
    absentRunner(f.stat.uid, f.mac, calls));
  await removeFresh(f.binding, {
    paths: nodePaths(f.binding.configRoot), adapter, readDaemonState: () => null, pidAlive: () => false, timeoutMs: 10,
  });
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(calls.some(call => call.includes(" bootout ")), false);
});

test("known stopped prior bytes recover after failed bootstrap only with complete process absence",
  { skip: process.platform !== "darwin" }, async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const adapter = new MacServiceAdapter(path.join(f.root, "service"), f.home, f.stat.uid, f.stat.gid,
    absentRunner(f.stat.uid, f.mac, []));
  const candidate = await adapter.read(f.binding);
  assert.ok(candidate);
  const previous = { ...candidate, definition: Buffer.from("PRIOR_PLIST"), running: false as const };
  await restorePrior({
    binding: f.binding, previous, previousBinding: f.binding, candidate,
    deps: { paths: nodePaths(f.binding.configRoot), adapter, readDaemonState: () => null, pidAlive: () => false, timeoutMs: 10 },
  });
  assert.equal(fs.readFileSync(f.file, "utf8"), "PRIOR_PLIST");
  });

test("failed bootstrap cleanup refuses matching orphan or unavailable process inventory", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const command = [f.binding.nodeExecutable, ...managedArguments(f.binding)].join(" ");
  const empty = new MacServiceAdapter(path.join(f.root, "empty"), f.home, f.stat.uid, f.stat.gid,
    absentRunner(f.stat.uid, f.mac, [], result(0)));
  await assert.rejects(() => empty.preflightStop(f.binding, undefined), /process inventory is unavailable/);

  const orphan = new MacServiceAdapter(path.join(f.root, "orphan"), f.home, f.stat.uid, f.stat.gid,
    absentRunner(f.stat.uid, f.mac, [], result(0, `12345 ${f.stat.uid} ${command}\n`)));
  await assert.rejects(() => orphan.preflightStop(f.binding, undefined), /daemon process remains/);

  const unknown = new MacServiceAdapter(path.join(f.root, "unknown"), f.home, f.stat.uid, f.stat.gid,
    absentRunner(f.stat.uid, f.mac, [], result(1, "", "unavailable")));
  await assert.rejects(() => unknown.preflightStop(f.binding, undefined), /process inventory is unavailable/);
  assert.equal(fs.existsSync(f.file), true);
});

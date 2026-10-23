// #677: the real MacServiceAdapter records the pre-bootout identity of the selected daemon and hands it, once, to its
// stop-proof hook. Fake launchctl/ps/osascript runner and fake signal; gated to macOS like the other adapter tests.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { managedArguments } from "./service-definitions.mts";
import { MacServiceAdapter } from "./service-platform-mac.mts";
import type { MacCommand, MacCommandResult } from "./service-platform-mac-native.mts";
import type { ServiceBinding } from "./service-types.mts";

const mac = { skip: process.platform !== "darwin" };
const uid = 1000, pid = 12345, label = "org.kherep.synthetic.reclaim";
const LSTART = "Thu Oct 23 10:00:00 2026";
const TIMEOUT = "managed service verification timed out";
const result = (status: number, stdout = "", stderr = ""): MacCommandResult => ({ status, stdout, stderr });

function fixture(t: test.TestContext, bootout = 0) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-mac-reclaim-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const file = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "SYNTHETIC_PLIST", { mode: 0o600 });
  const binding: ServiceBinding = { serviceName: label, platform: "darwin", workspace: root, configRoot: path.join(root, "config"),
    nodeExecutable: process.execPath,
    source: { root: path.join(root, "pin"), commit: "a".repeat(40), digest: "b".repeat(64), kind: "pin", verified: true } };
  const args = [process.execPath, ...managedArguments(binding)];
  let loaded = true, tick = 0;
  const calls: string[] = [];
  const signals: Array<[number, string]> = [];
  let alive = () => true;
  const run: MacCommand = (command, argv) => {
    calls.push([command, ...argv].join(" "));
    if (command === "launchctl" && argv[0] === "print" && argv[1] === `gui/${uid}/${label}`) {
      if (!loaded) return result(113, "", `Bad request.\nCould not find service "${label}" in domain for user gui: ${uid}\n`);
      return result(0, `gui/${uid}/${label} = {\n\tpath = ${file}\n\ttype = LaunchAgent\n\tstate = running\n\tprogram = ${args[0]}\n`
        + `\targuments = {\n${args.map(value => `\t\t${value}\n`).join("")}\t}\n`
        + `\tinherited environment = {\n\t}\n\tdefault environment = {\n\t}\n\tenvironment = {\n\t}\n\tpid = ${pid}\n}\n`);
    }
    if (command === "launchctl" && argv[0] === "print") return result(0, `gui/${uid} = {\n}\n`);
    if (command === "launchctl" && argv[0] === "bootout") { if (bootout === 0) loaded = false; return result(bootout); }
    if (command === "plutil") return result(0, JSON.stringify({ Label: label, ProgramArguments: args }));
    if (command === "ps" && argv.includes("-p")) return alive() ? result(0, `${LSTART} ${uid} ${pid} 1 ${args.join(" ")}\n`) : result(1);
    if (command === "ps" && argv.includes("-axo")) return result(0, `${alive() ? `${pid} 1 ${pid} ${uid} ${LSTART} ${args.join(" ")}\n` : ""}1 0 1 0 ${LSTART} /sbin/launchd\n`);
    if (command === "/usr/bin/osascript") return alive() ? result(0, `${process.execPath}\n`) : result(1);
    return result(1, "", "unexpected synthetic command");
  };
  const clock = { now: () => tick, sleep: async (ms: number) => { tick += ms; } };
  const adapter = new MacServiceAdapter(path.join(root, "service"), home, uid, fs.lstatSync(file).gid, run, clock,
    (target, signal) => { signals.push([target, signal]); });
  const expected = { pid, startedAt: new Date(Date.parse(LSTART)).toISOString() };
  const prove = (forPid = pid) => adapter.proveStopped!(binding, { ...expected, pid: forPid },
    { alive: () => alive(), clock, deadline: tick + 75_000 });
  return { adapter, binding, expected, calls, signals, prove, setAlive: (value: () => boolean) => { alive = value; } };
}

test("Mac stop snapshots the process identity after the attestations and before bootout", mac, async (t) => {
  const f = fixture(t);
  await f.adapter.stop(f.binding, f.expected);
  const identity = f.calls.findIndex(call => call.startsWith("ps -ww -p "));
  const bootout = f.calls.findIndex(call => call.startsWith("launchctl bootout "));
  assert.ok(identity > f.calls.findIndex(call => call.startsWith("plutil ")), "after the plist attestation");
  assert.ok(identity > f.calls.findIndex(call => call.startsWith("launchctl print ")), "no ps before print");
  assert.equal(f.calls[identity + 1].startsWith("/usr/bin/osascript "), true);
  assert.equal(bootout, identity + 2, "the snapshot is the last read before bootout");
});

test("Mac stop with bootout 0 and an unlisted live pid hands the snapshot to reclaim", mac, async (t) => {
  const f = fixture(t);
  const report = t.mock.method(console, "error", () => {});
  await f.adapter.stop(f.binding, f.expected);
  f.setAlive(() => f.signals.length === 0);
  await f.prove();
  assert.deepEqual(f.signals, [[pid, "SIGTERM"]]);
  assert.equal(report.mock.callCount(), 1, "one stderr line without pid or path");
});

test("no stop receipt for the passed pid means no signal", mac, async (t) => {
  const f = fixture(t);
  await assert.rejects(f.prove(), { message: TIMEOUT });
  await f.adapter.stop(f.binding, f.expected);
  await assert.rejects(f.prove(pid + 1), { message: TIMEOUT }, "a receipt binds exactly one pid");
  assert.deepEqual(f.signals, []);
});

test("a stop whose bootout fails leaves no stop receipt behind", mac, async (t) => {
  const f = fixture(t, 36);
  await assert.rejects(f.adapter.stop(f.binding, f.expected), /could not prove the selected service stopped/);
  await assert.rejects(f.prove(), { message: TIMEOUT });
  assert.deepEqual(f.signals, []);
});

test("the stop receipt is consumed by the first stop proof", mac, async (t) => {
  const f = fixture(t);
  await f.adapter.stop(f.binding, f.expected);
  f.setAlive(() => false);
  await f.prove();
  f.setAlive(() => true);
  await assert.rejects(f.prove(), { message: TIMEOUT });
  assert.deepEqual(f.signals, []);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { nodePaths } from "./config.mts";
import { managedArguments } from "./service-definitions.mts";
import { removeFresh, restorePrior } from "./service-lifecycle.mts";
import { MacServiceAdapter } from "./service-platform-mac.mts";
import { attestMacLaunchAgent, type MacCommand, type MacCommandResult } from "./service-platform-mac-native.mts";
import type { ServiceAdapter, ServiceBinding } from "./service-types.mts";

const label = "org.kherep.synthetic.final";
const result = (status: number, stdout = "", stderr = ""): MacCommandResult => ({ status, stdout, stderr });

function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-mac-final-")));
  const home = path.join(root, "home");
  const file = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "SYNTHETIC_PLIST", { mode: 0o600 });
  const stat = fs.lstatSync(file);
  const binding: ServiceBinding = {
    serviceName: label, platform: "darwin", workspace: root, configRoot: path.join(root, "config"),
    nodeExecutable: path.join(root, "node"),
    source: { root: path.join(root, "source"), commit: "a".repeat(40), digest: "b".repeat(64), kind: "pin", verified: true },
  };
  const args = [binding.nodeExecutable, ...managedArguments(binding)];
  return { root, home, file, stat, binding, args };
}

function loaded(f: ReturnType<typeof fixture>, args = f.args, pid?: number, paths: Record<string, string> = {}): string {
  return `gui/${f.stat.uid}/${label} = {\n\tpath = ${f.file}\n\ttype = LaunchAgent\n\tstate = ${pid ? "running" : "waiting"}\n`
    + `\tprogram = ${args[0]}\n${paths.workingDirectory ? `\tworking directory = ${paths.workingDirectory}\n` : ""}`
    + `${paths.stdoutPath ? `\tstdout path = ${paths.stdoutPath}\n` : ""}${paths.stderrPath ? `\tstderr path = ${paths.stderrPath}\n` : ""}`
    + `\targuments = {\n${args.map(value => `\t\t${value}\n`).join("")}\t}\n`
    + "\tinherited environment = {\n\t}\n\tdefault environment = {\n\t}\n\tenvironment = {\n\t}\n"
    + `${pid ? `\tpid = ${pid}\n` : ""}}\n`;
}

test("Mac loaded optional paths require matching configured presence and value", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const configured = { Label: label, ProgramArguments: f.args };
  const fields = [
    ["workingDirectory", f.root], ["stdoutPath", path.join(f.root, "stdout.log")],
    ["stderrPath", path.join(f.root, "stderr.log")],
  ] as const;
  for (const [key, value] of fields) {
    assert.throws(() => attestMacLaunchAgent({ kind: "loaded", origin: f.file, program: f.args[0],
      arguments: f.args, [key]: value }, f.file, configured), /loaded definition does not match/);
  }
});

interface RunnerOptions { inventory: MacCommandResult; observedArgs?: string[]; appearPid?: number; absent?: boolean }

function runner(f: ReturnType<typeof fixture>, options: RunnerOptions, calls: string[]): MacCommand {
  let bootedOut = false;
  let selectedPrints = 0;
  const observedArgs = options.observedArgs ?? f.args;
  const mac = { Label: label, ProgramArguments: observedArgs };
  return (file, args) => {
    calls.push([file, ...args].join(" "));
    if (file === "launchctl" && args[0] === "print" && args[1] === `gui/${f.stat.uid}/${label}`) {
      selectedPrints += 1;
      if (!bootedOut && !options.absent) {
        return result(0, loaded(f, observedArgs, options.appearPid && selectedPrints >= 2 ? options.appearPid : undefined));
      }
      return result(113, "", `Bad request.\nCould not find service "${label}" in domain for user gui: ${f.stat.uid}\n`);
    }
    if (file === "launchctl" && args[0] === "print" && args[1] === `gui/${f.stat.uid}`) {
      return result(0, `gui/${f.stat.uid} = {\n}\n`);
    }
    if (file === "launchctl" && args[0] === "bootout") { bootedOut = true; return result(0); }
    if (file === "plutil") return result(0, JSON.stringify(mac));
    if (file === "/bin/ls") return result(0, "-rw------- 1 operator staff 1 Oct 14 10:00 service.plist\n");
    if (file === "ps" && args[0] === "-ww" && args[1] === "-axo") return options.inventory;
    return result(1, "", "unexpected synthetic command");
  };
}

test("Mac lifecycle refuses a pid-less loaded job with observed orphan or unreadable inventory", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const observed = [f.binding.nodeExecutable, path.join(f.root, "observed", "custom.mts")];
  for (const options of [
    { observedArgs: observed, inventory: result(0, `12345 ${f.stat.uid} ${observed.join(" ")}\n`) },
    { inventory: result(1, "", "unavailable") },
    { inventory: result(0, `123 ${f.stat.uid} /usr/bin/unrelated\n`), appearPid: 12345 },
  ]) {
    const calls: string[] = [];
    const adapter = new MacServiceAdapter(path.join(f.root, `service-${calls.length}`), f.home, f.stat.uid, f.stat.gid,
      runner(f, options, calls));
    await assert.rejects(() => removeFresh(f.binding, {
      paths: nodePaths(f.binding.configRoot), adapter, readDaemonState: () => null, pidAlive: () => false, timeoutMs: 10,
    }));
    assert.equal(calls.some(call => call.includes(" bootout ")), false);
    assert.equal(fs.existsSync(f.file), true);
  }
});

test("Mac direct no-context stop refuses absent-job orphan and a pid appearing after inventory", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  for (const options of [
    { absent: true, inventory: result(0, `12345 ${f.stat.uid} ${f.args.join(" ")}\n`) },
    { inventory: result(0, `123 ${f.stat.uid} /usr/bin/unrelated\n`), appearPid: 12345 },
  ]) {
    const calls: string[] = [];
    const adapter = new MacServiceAdapter(path.join(f.root, "service-direct"), f.home, f.stat.uid, f.stat.gid,
      runner(f, options, calls));
    await assert.rejects(() => adapter.stop(f.binding, undefined));
    assert.equal(calls.some(call => call.includes(" bootout ")), false);
  }
});

test("Mac lifecycle removes a pid-less loaded candidate only after clean inventory", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const calls: string[] = [];
  const adapter = new MacServiceAdapter(path.join(f.root, "service-clean"), f.home, f.stat.uid, f.stat.gid,
    runner(f, { inventory: result(0, `123 ${f.stat.uid} /usr/bin/unrelated\n`) }, calls));
  await removeFresh(f.binding, {
    paths: nodePaths(f.binding.configRoot), adapter, readDaemonState: () => null, pidAlive: () => false, timeoutMs: 10,
  });
  assert.equal(calls.some(call => call.startsWith("ps -ww -axo ")), true);
  assert.equal(calls.filter(call => call.includes(" bootout ")).length, 1);
  assert.equal(fs.existsSync(f.file), false);
});

test("Mac recovery preflights and stops a pid-less prior definition before declaring absence", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const previous = { definition: Buffer.from("PRIOR"), security: Buffer.from("SECURITY"), running: false as const };
  const calls: string[] = [];
  let reads = 0;
  const adapter = {
    read: async () => (++reads === 1 ? { ...previous, running: "unknown" as const } : previous),
    preflightStop: async (_binding: ServiceBinding, expected: unknown) => { assert.equal(expected, undefined); calls.push("preflight"); },
    stop: async () => { calls.push("stop"); }, write: async () => { calls.push("write"); },
  } as unknown as ServiceAdapter;
  await restorePrior({ binding: f.binding, previous, previousBinding: f.binding,
    deps: { paths: nodePaths(f.binding.configRoot), adapter, readDaemonState: () => null, pidAlive: () => false, timeoutMs: 10 } });
  assert.deepEqual(calls, ["preflight", "stop", "write"]);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MacServiceAdapter } from "./service-platform-mac.mts";
import {
  parseLaunchctlPrint, probeMacLaunchAgent, type MacCommand, type MacCommandResult,
} from "./service-platform-mac-native.mts";
import type { ServiceBinding } from "./service-types.mts";
const uid = 1000;
const label = "org.kherep.synthetic";
const target = `gui/${uid}/${label}`;
interface LoadedPaths { workingDirectory?: string; stdoutPath?: string; stderrPath?: string }
const loaded = (origin: string, program: string, args: string[], pid?: number, paths: LoadedPaths = {}): string => `${target} = {
\tpath = ${origin}
\ttype = LaunchAgent
\tstate = ${pid ? "running" : "waiting"}
\tprogram = ${program}
${paths.workingDirectory ? `\tworking directory = ${paths.workingDirectory}\n` : ""}${paths.stdoutPath ? `\tstdout path = ${paths.stdoutPath}\n` : ""}${paths.stderrPath ? `\tstderr path = ${paths.stderrPath}\n` : ""}\targuments = {
${args.map(value => `\t\t${value}\n`).join("")}\t}
\tinherited environment = {
\t\tSYNTHETIC_ENV_KEY0 => synthetic-value
\t}
\tdefault environment = {
\t\tSYNTHETIC_ENV_KEY0 => synthetic-value
\t}
\tenvironment = {
\t\tSYNTHETIC_ENV_KEY0 => synthetic-value
\t\tSYNTHETIC_ENV_KEY1 => synthetic-value
\t}
${pid ? `\tpid = ${pid}\n` : ""}}
`;

const result = (status: number, stdout = "", stderr = ""): MacCommandResult => ({ status, stdout, stderr });
const oneResult = (value: MacCommandResult): MacCommand => () => value;
const sequence = (...values: MacCommandResult[]): MacCommand => () => values.shift() ?? result(1, "", "missing fixture");
test("launchctl probe accepts only the measured loaded and absent forms", () => {
  const origin = "/synthetic/Library/LaunchAgents/org.kherep.synthetic.plist";
  const output = loaded(origin, "/synthetic/node", ["/synthetic/node", "/synthetic/cli.mts", "daemon"], 12345);
  assert.deepEqual(parseLaunchctlPrint(output, target), {
    kind: "loaded", origin, program: "/synthetic/node",
    arguments: ["/synthetic/node", "/synthetic/cli.mts", "daemon"], pid: 12345,
  });
  assert.equal(parseLaunchctlPrint(loaded(origin, "/synthetic/node", ["/synthetic/node"]), target).kind, "loaded");
  const absent = result(113, "", `Bad request.\nCould not find service "${label}" in domain for user gui: ${uid}\n`);
  const domain = result(0, `gui/${uid} = {\n}\n`);
  assert.deepEqual(probeMacLaunchAgent(sequence(absent, domain), uid, label), { kind: "absent" });
  assert.throws(() => probeMacLaunchAgent(sequence(absent, result(1, "", "unreadable")), uid, label), /identity is unavailable/);
  assert.throws(() => probeMacLaunchAgent(sequence(absent, result(0, `gui/${uid + 1} = {\n}\n`)), uid, label), /identity is unavailable/);
  assert.throws(() => probeMacLaunchAgent(oneResult(result(113, "", "Bad request.\n")), uid, label), /identity is unavailable/);
  assert.throws(() => probeMacLaunchAgent(oneResult(result(0, output, "unexpected\n")), uid, label), /identity is unavailable/);
});

test("launchctl probe captures strict working and log paths", () => {
  const paths = { workingDirectory: "/synthetic/work", stdoutPath: "/synthetic/out.log", stderrPath: "/synthetic/err.log" };
  const output = loaded("/synthetic/agent.plist", "/synthetic/node", ["/synthetic/node"], 12345, paths);
  assert.deepEqual(parseLaunchctlPrint(output, target), {
    kind: "loaded", origin: "/synthetic/agent.plist", program: "/synthetic/node", arguments: ["/synthetic/node"], pid: 12345,
    ...paths,
  });
  assert.throws(() => parseLaunchctlPrint(output.replace("\tstdout path = /synthetic/out.log\n",
    "\tstdout path = relative.log\n"), target), /identity is unavailable/);
  assert.throws(() => parseLaunchctlPrint(output.replace("\tstdout path = /synthetic/out.log\n", "\tstdout path = \n"), target), /identity is unavailable/);
  assert.throws(() => parseLaunchctlPrint(output.replace("\tstderr path = /synthetic/err.log\n",
    "\tstderr path = /synthetic/err.log\n\tstderr path = /synthetic/other.log\n"), target), /identity is unavailable/);
});

test("launchctl parser refuses missing or duplicate origins and malformed or duplicate pids", () => {
  const origin = "/synthetic/Library/LaunchAgents/org.kherep.synthetic.plist";
  const output = loaded(origin, "/synthetic/node", ["/synthetic/node"], 12345);
  assert.throws(() => parseLaunchctlPrint(output.replace(`\tpath = ${origin}\n`, ""), target), /identity is unavailable/);
  assert.throws(() => parseLaunchctlPrint(output.replace(`\tpath = ${origin}\n`, `\tpath = ${origin}\n\tpath = ${origin}\n`), target), /identity is unavailable/);
  assert.throws(() => parseLaunchctlPrint(output.replace("\tpid = 12345\n", "\tpid = nope\n"), target), /identity is unavailable/);
  assert.throws(() => parseLaunchctlPrint(output.replace("\tpid = 12345\n", "\tpid = 12345\n\tpid = 12345\n"), target), /identity is unavailable/);
});

test("launchctl parser refuses malformed or execution-affecting loaded environments", () => {
  const output = loaded("/synthetic/agent.plist", "/synthetic/node", ["/synthetic/node"], 12345);
  assert.throws(() => parseLaunchctlPrint(output.replace("\t\tSYNTHETIC_ENV_KEY1 => synthetic-value", "\t\tmalformed"), target),
    /identity is unavailable/);
  for (const name of ["inherited environment", "default environment", "environment"]) {
    const header = `\t${name} = {\n`;
    assert.throws(() => parseLaunchctlPrint(output.replace(header, `${header}\t\tNoDe_OpTiOnS => hidden\n`), target),
      /execution-affecting environment/);
  }
  const empty = output.replace(/(\t(?:inherited environment|default environment|environment) = \{\n)(?:\t\t[^\n]+\n)+(\t\})/gu, "$1$2");
  assert.equal(parseLaunchctlPrint(empty, target).kind, "loaded");
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-mac-origin-"));
  const home = path.join(root, "home");
  const file = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "SYNTHETIC_PLIST", { mode: 0o600 });
  const stat = fs.lstatSync(file);
  const node = path.join(root, "node");
  const cli = path.join(root, "source", "modules", "control-plane", "node", "cli.mts");
  const args = [node, cli, "daemon"];
  const binding: ServiceBinding = {
    serviceName: label, platform: "darwin", workspace: root, configRoot: path.join(root, "config"), nodeExecutable: node,
    source: { root: path.join(root, "source"), commit: "a".repeat(40), digest: "b".repeat(64), kind: "pin", verified: true },
  };
  return { root, home, file, stat, node, args, binding };
}

function nativeRunner(outputs: MacCommandResult[], mac: Record<string, unknown>, calls: string[], processInventory = ""): MacCommand {
  return (file, args) => {
    calls.push([file, ...args].join(" "));
    if (file === "launchctl" && args[0] === "print") return outputs.shift() ?? result(1, "", "missing fixture");
    if (file === "launchctl" && args[0] === "bootout") return result(0);
    if (file === "plutil") return result(0, JSON.stringify(mac));
    if (file === "/bin/ls") return result(0, "-rw------- 1 operator staff 1 Oct 14 10:00 service.plist\n");
    if (file === "ps" && args[0] === "-ww" && args[1] === "-axo") return result(0, processInventory);
    if (file === "ps" && args[0] === "-axo") return result(0, "12345 1\n");
    return result(1, "", "unexpected synthetic command");
  };
}

test("Mac read binds raw backup to one stable loaded origin and definition", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const mac = { Label: label, ProgramArguments: f.args };
  const exact = loaded(f.file, f.node, f.args, 12345);
  const calls: string[] = [];
  const adapter = new MacServiceAdapter(path.join(f.root, "service"), f.home, uid, f.stat.gid,
    nativeRunner([result(0, exact), result(0, exact)], mac, calls));
  const snapshot = await adapter.read(f.binding);
  assert.equal(snapshot?.pid, 12345);
  assert.equal(snapshot?.definition.toString(), "SYNTHETIC_PLIST");

  const foreign = loaded(path.join(f.root, "foreign.plist"), f.node, f.args, 12345);
  const foreignCalls: string[] = [];
  const foreignAdapter = new MacServiceAdapter(path.join(f.root, "service2"), f.home, uid, f.stat.gid,
    nativeRunner([result(0, foreign)], mac, foreignCalls));
  await assert.rejects(() => foreignAdapter.read(f.binding), /origin does not match/);
  assert.equal(foreignCalls.some(call => call.startsWith("plutil ") || call.startsWith("/bin/ls ")), false);

  const driftAdapter = new MacServiceAdapter(path.join(f.root, "service3"), f.home, uid, f.stat.gid,
    nativeRunner([result(0, exact), result(0, loaded(f.file, f.node, f.args, 12346))], mac, []));
  await assert.rejects(() => driftAdapter.read(f.binding), /identity changed/);

  const nativePaths = { workingDirectory: f.root, stdoutPath: path.join(f.root, "stdout.log"),
    stderrPath: path.join(f.root, "stderr.log") };
  const pathDrift = new MacServiceAdapter(path.join(f.root, "service-path-drift"), f.home, uid, f.stat.gid,
    nativeRunner([result(0, loaded(f.file, f.node, f.args, 12345, nativePaths)),
      result(0, loaded(f.file, f.node, f.args, 12345, { ...nativePaths, stdoutPath: path.join(f.root, "other.log") }))], mac, []));
  await assert.rejects(() => pathDrift.read(f.binding), /identity changed/);

  const configuredPaths = { ...mac, WorkingDirectory: nativePaths.workingDirectory,
    StandardOutPath: nativePaths.stdoutPath, StandardErrorPath: nativePaths.stderrPath };
  const pathMismatch = new MacServiceAdapter(path.join(f.root, "service-path-mismatch"), f.home, uid, f.stat.gid,
    nativeRunner([result(0, loaded(f.file, f.node, f.args, 12345,
      { ...nativePaths, stderrPath: path.join(f.root, "other.log") }))], configuredPaths, []));
  await assert.rejects(() => pathMismatch.read(f.binding), /loaded definition does not match/);

  const mismatch = new MacServiceAdapter(path.join(f.root, "service4"), f.home, uid, f.stat.gid,
    nativeRunner([result(0, loaded(f.file, f.node, [f.node, "foreign"], 12345))], mac, []));
  await assert.rejects(() => mismatch.read(f.binding), /loaded definition does not match/);

  fs.rmSync(f.file);
  const absentFileCalls: string[] = [];
  const absentFile = new MacServiceAdapter(path.join(f.root, "service5"), f.home, uid, f.stat.gid,
    nativeRunner([result(0, foreign)], mac, absentFileCalls));
  await assert.rejects(() => absentFile.read(f.binding), /origin does not match/);
  assert.equal(absentFileCalls.some(call => call.startsWith("plutil ") || call.startsWith("/bin/ls ")), false);

  const absent = result(113, "",
    `Bad request.\nCould not find service "${label}" in domain for user gui: ${uid}\n`);
  const domain = result(0, `gui/${uid} = {\n}\n`);
  const stableAbsent = new MacServiceAdapter(path.join(f.root, "service6"), f.home, uid, f.stat.gid,
    nativeRunner([absent, domain, absent, domain], mac, []));
  assert.equal(await stableAbsent.read(f.binding), null);

  const appeared = new MacServiceAdapter(path.join(f.root, "service6"), f.home, uid, f.stat.gid,
    nativeRunner([absent, domain, result(0, foreign)], mac, []));
  await assert.rejects(() => appeared.read(f.binding), /identity changed/);

  const unreadable = new MacServiceAdapter(path.join(f.root, "service7"), f.home, uid, f.stat.gid,
    nativeRunner([absent, domain, result(1, "", "synthetic unreadable domain")], mac, []));
  await assert.rejects(() => unreadable.read(f.binding), /identity is unavailable/);
});

test("Mac read rejects definition and security drift between native probes", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const mac = { Label: label, ProgramArguments: f.args };
  const exact = loaded(f.file, f.node, f.args, 12345);

  let prints = 0;
  const byteBase = nativeRunner([result(0, exact), result(0, exact)], mac, []);
  const byteDrift: MacCommand = (file, args, timeout, env) => {
    if (file === "launchctl" && args[0] === "print" && ++prints === 2) fs.writeFileSync(f.file, "CHANGED_PLIST");
    return byteBase(file, args, timeout, env);
  };
  const byteAdapter = new MacServiceAdapter(path.join(f.root, "byte-drift"), f.home, uid, f.stat.gid, byteDrift);
  await assert.rejects(() => byteAdapter.read(f.binding), /definition changed/);

  fs.writeFileSync(f.file, "SYNTHETIC_PLIST", { mode: 0o600 });
  let securityReads = 0;
  const securityBase = nativeRunner([result(0, exact), result(0, exact)], mac, []);
  const securityDrift: MacCommand = (file, args, timeout, env) => {
    if (file === "/bin/ls" && ++securityReads === 2) {
      return result(0, "-rw------- 1 operator staff 1 Oct 14 10:00 service.plist\n 0: synthetic ACL entry\n");
    }
    return securityBase(file, args, timeout, env);
  };
  const securityAdapter = new MacServiceAdapter(path.join(f.root, "security-drift"), f.home, uid, f.stat.gid, securityDrift);
  await assert.rejects(() => securityAdapter.read(f.binding), /extended ACL/);
});

test("Mac stop re-attests origin and pid before bootout", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const mac = { Label: label, ProgramArguments: f.args };
  const foreign = loaded(path.join(f.root, "foreign.plist"), f.node, f.args, 12345);
  const calls: string[] = [];
  const adapter = new MacServiceAdapter(path.join(f.root, "service"), f.home, uid, f.stat.gid,
    nativeRunner([result(0, foreign)], mac, calls));
  await assert.rejects(() => adapter.stop(f.binding, { pid: 12345, startedAt: new Date().toISOString() }), /origin does not match/);
  assert.equal(calls.some(call => call.includes(" bootout ")), false);

  const validCalls: string[] = [];
  const exact = loaded(f.file, f.node, f.args, 12345);
  const valid = new MacServiceAdapter(path.join(f.root, "service2"), f.home, uid, f.stat.gid,
    nativeRunner([result(0, exact)], mac, validCalls));
  await valid.stop(f.binding, { pid: 12345, startedAt: new Date().toISOString() });
  assert.equal(validCalls.filter(call => call.includes(" bootout ")).length, 1);

  const expectedPaths = { WorkingDirectory: f.root, StandardOutPath: path.join(f.root, "stdout.log"),
    StandardErrorPath: path.join(f.root, "stderr.log") };
  const pathCalls: string[] = [];
  const pathMismatch = new MacServiceAdapter(path.join(f.root, "service-path"), f.home, uid, f.stat.gid,
    nativeRunner([result(0, loaded(f.file, f.node, f.args, 12345, {
      workingDirectory: f.root, stdoutPath: expectedPaths.StandardOutPath, stderrPath: path.join(f.root, "other.log"),
    }))], { ...mac, ...expectedPaths }, pathCalls));
  await assert.rejects(() => pathMismatch.stop(f.binding,
    { pid: 12345, startedAt: new Date().toISOString() }), /loaded definition does not match/);
  assert.equal(pathCalls.some(call => call.includes(" bootout ")), false);

  const driftCalls: string[] = [];
  const drift = new MacServiceAdapter(path.join(f.root, "service3"), f.home, uid, f.stat.gid,
    nativeRunner([result(0, exact), result(0, foreign)], mac, driftCalls));
  const expected = { pid: 12345, startedAt: new Date().toISOString() };
  await drift.preflightStop(f.binding, expected);
  await assert.rejects(() => drift.stop(f.binding, expected), /origin does not match/);
  assert.equal(driftCalls.some(call => call.includes(" bootout ")), false);
});

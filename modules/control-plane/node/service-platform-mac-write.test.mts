import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MacServiceAdapter } from "./service-platform-mac.mts";
import type { MacCommand, MacCommandResult } from "./service-platform-mac-native.mts";
import { observeLoadedForWrite, realMacWriteClock } from "./service-platform-mac-write-guard.mts";
import type { ServiceBinding } from "./service-types.mts";

const label = "org.kherep.synthetic.write";
const result = (status: number, stdout = "", stderr = ""): MacCommandResult => ({ status, stdout, stderr });

function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-mac-write-")));
  const home = path.join(root, "home");
  const agents = path.join(home, "Library", "LaunchAgents");
  const file = path.join(agents, `${label}.plist`);
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(file, "OLD_PLIST", { mode: 0o600 });
  const stat = fs.lstatSync(file);
  const node = path.join(root, "node");
  const cli = path.join(root, "source", "modules", "control-plane", "node", "cli.mts");
  const argsOld = [node, cli, "daemon"];
  const argsNew = [node, cli, "daemon", "--new"];
  const binding: ServiceBinding = {
    serviceName: label, platform: "darwin", workspace: root, configRoot: path.join(root, "config"), nodeExecutable: node,
    source: { root: path.join(root, "source"), commit: "a".repeat(40), digest: "b".repeat(64), kind: "pin", verified: true },
  };
  const metadata = Buffer.from(JSON.stringify({ mode: 0o600, uid: stat.uid, gid: stat.gid, acl: "absent" }));
  const absent = result(113, "", `Bad request.\nCould not find service "${label}" in domain for user gui: ${stat.uid}\n`);
  return { root, home, agents, file, stat, argsOld, argsNew, binding, metadata, absent };
}
type Fixture = ReturnType<typeof fixture>;

function loaded(f: Fixture, args: string[], pid?: number): MacCommandResult {
  return result(0, `gui/${f.stat.uid}/${label} = {\n\tpath = ${f.file}\n\ttype = LaunchAgent\n`
    + `\tstate = ${pid ? "running" : "waiting"}\n\tprogram = ${args[0]}\n`
    + `\targuments = {\n${args.map(value => `\t\t${value}\n`).join("")}\t}\n`
    + "\tinherited environment = {\n\t}\n\tdefault environment = {\n\t}\n\tenvironment = {\n\t}\n"
    + `${pid ? `\tpid = ${pid}\n` : ""}}\n`);
}

function runner(f: Fixture, prints: MacCommandResult[], calls: string[],
  domain = result(0, `gui/${f.stat.uid} = {\n}\n`)): MacCommand {
  return (file, args) => {
    calls.push([file, ...args].join(" "));
    if (file === "launchctl" && args[0] === "print" && args[1] === `gui/${f.stat.uid}/${label}`) {
      return prints.length > 1 ? prints.shift()! : prints[0];
    }
    if (file === "launchctl" && args[0] === "print" && args[1] === `gui/${f.stat.uid}`) return domain;
    if (file === "plutil") {
      const content = fs.readFileSync(args.at(-1)!, "utf8");
      return result(0, JSON.stringify({ Label: label, ProgramArguments: content === "NEW_PLIST" ? f.argsNew : f.argsOld }));
    }
    if (file === "/bin/ls") return result(0, "-rw------- 1 operator staff 1 Oct 14 10:00 service.plist\n");
    return result(1, "", "unexpected synthetic command");
  };
}

function setup(t: test.TestContext, prints: (f: Fixture) => MacCommandResult[], domain?: (f: Fixture) => MacCommandResult,
  delay: (call: string, index: number) => number = () => 0) {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const calls: string[] = [];
  let tick = 0;
  const sleeps: number[] = [];
  const clock = { now: () => tick, sleep: async (ms: number) => { sleeps.push(ms); tick += ms; } };
  const run = runner(f, prints(f), calls, domain?.(f));
  const timed: MacCommand = (file, args, ...rest) => {
    const answer = run(file, args, ...rest);
    tick += delay(calls.at(-1)!, calls.length - 1);
    return answer;
  };
  const adapter = new MacServiceAdapter(path.join(f.root, "service"), f.home, f.stat.uid, f.stat.gid, timed, clock);
  const write = (content: string) => adapter.write(f.binding, Buffer.from(content), f.metadata);
  const labelPrints = () => calls.filter(call => call.startsWith(`launchctl print gui/${f.stat.uid}/${label}`)).length;
  const domainPrints = () => calls.filter(call => call === `launchctl print gui/${f.stat.uid}`).length;
  const plutils = () => calls.filter(call => call.startsWith("plutil "));
  const noTemp = () => assert.deepEqual(fs.readdirSync(f.agents).filter(name => name.endsWith(".tmp")), []);
  const content = () => fs.readFileSync(f.file, "utf8");
  return { f, calls, sleeps, tick: () => tick, write, labelPrints, domainPrints, plutils, noTemp, content };
}

test("Mac write over a job launchd reports not found proceeds after one probe", async (t) => {
  const s = setup(t, f => [f.absent]);
  await s.write("NEW_PLIST");
  assert.equal(s.content(), "NEW_PLIST");
  assert.equal(s.labelPrints(), 1);
  assert.equal(s.domainPrints(), 1);
  assert.equal(s.plutils().length, 0);
  assert.equal(s.sleeps.length, 0);
  s.noTemp();
});

test("Mac write waits for a listed job to become not found inside the grace", async (t) => {
  const s = setup(t, f => [loaded(f, f.argsOld), f.absent]);
  await s.write("NEW_PLIST");
  assert.equal(s.content(), "NEW_PLIST");
  assert.equal(s.labelPrints(), 2);
  assert.equal(s.plutils().length, 1);
  assert.ok(s.plutils()[0].endsWith(".tmp"));
  assert.deepEqual(s.sleeps, [100]);
  assert.equal(s.tick(), 100);
  s.noTemp();
});

test("Mac write refuses a job still loaded with a different definition after the grace", async (t) => {
  const s = setup(t, f => [loaded(f, f.argsOld)]);
  await assert.rejects(s.write("NEW_PLIST"), /still loaded with a different definition/);
  assert.equal(s.content(), "OLD_PLIST");
  assert.equal(s.labelPrints(), 11);
  assert.equal(s.sleeps.length, 10);
  assert.ok(s.sleeps.every(ms => ms === 100));
  assert.equal(s.plutils().length, 1);
  s.noTemp();
});

test("Mac write over a listed job with the same bytes and an attesting identity proceeds", async (t) => {
  const s = setup(t, f => [loaded(f, f.argsOld)]);
  await s.write("OLD_PLIST");
  assert.equal(s.content(), "OLD_PLIST");
  assert.equal(s.labelPrints(), 1);
  assert.equal(s.plutils().length, 1);
  assert.equal(s.sleeps.length, 0);
  s.noTemp();
});

test("Mac write refuses same bytes when the loaded identity differs", async (t) => {
  const s = setup(t, f => [loaded(f, f.argsNew)]);
  await assert.rejects(s.write("OLD_PLIST"), /still loaded with a different definition/);
  assert.equal(s.labelPrints(), 11);
  assert.equal(s.sleeps.length, 10);
  assert.equal(s.content(), "OLD_PLIST");
  s.noTemp();
});

test("Mac write refuses at once when the first probe cannot be read", async (t) => {
  const s = setup(t, () => [result(1, "", "synthetic unreadable")]);
  const error = await s.write("NEW_PLIST").then(() => undefined, (caught: unknown) => caught);
  assert.ok(error instanceof Error);
  assert.match(error.message, /loaded state could not be read before write/);
  assert.ok(error.cause instanceof Error);
  assert.match(error.cause.message, /identity is unavailable/);
  assert.equal(s.labelPrints(), 1);
  assert.equal(s.sleeps.length, 0);
  assert.equal(s.plutils().length, 0);
  assert.equal(s.content(), "OLD_PLIST");
  s.noTemp();
});

test("Mac write never counts not found with an unreadable domain as absent", async (t) => {
  const s = setup(t, f => [f.absent], () => result(1, "", "unreadable"));
  await assert.rejects(s.write("NEW_PLIST"), /loaded state could not be read before write/);
  assert.equal(s.content(), "OLD_PLIST");
  assert.equal(s.sleeps.length, 0);
});

test("Mac write refuses at once when a later probe cannot be read", async (t) => {
  const s = setup(t, f => [loaded(f, f.argsOld), result(1, "", "unreadable")]);
  await assert.rejects(s.write("NEW_PLIST"), /loaded state could not be read before write/);
  assert.deepEqual(s.sleeps, [100]);
  assert.equal(s.content(), "OLD_PLIST");
  s.noTemp();
});

test("Mac loaded-write observation classifies listed, not found and read errors", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const run = runner(f, [loaded(f, f.argsOld, 4242), f.absent, result(0, "garbage")], []);
  const listed = observeLoadedForWrite(run, f.stat.uid, label);
  assert.equal(listed.state, "listed");
  assert.ok(listed.state === "listed" && listed.probe.kind === "loaded" && listed.probe.pid === 4242);
  assert.deepEqual(observeLoadedForWrite(run, f.stat.uid, label), { state: "not-found" });
  const failed = observeLoadedForWrite(run, f.stat.uid, label);
  assert.equal(failed.state, "read-error");
  assert.ok(failed.state === "read-error" && failed.cause instanceof Error);
  assert.match((failed.cause as Error).message, /identity is unavailable/);
});

const isLabelPrint = (call: string) => call.startsWith("launchctl print gui/") && call.endsWith(`/${label}`);

test("Mac write grace is consumed by a slow print and no probe starts after it", async (t) => {
  const s = setup(t, f => [loaded(f, f.argsOld)], undefined, call => isLabelPrint(call) ? 1_500 : 0);
  await assert.rejects(s.write("NEW_PLIST"), /still loaded with a different definition/);
  assert.equal(s.labelPrints(), 1);
  assert.equal(s.sleeps.length, 0);
  assert.equal(s.tick(), 1_500);
  assert.equal(s.content(), "OLD_PLIST");
  s.noTemp();
});

test("Mac write grace is consumed by a slow plutil and no probe starts after it", async (t) => {
  const s = setup(t, f => [loaded(f, f.argsOld)], undefined, call => call.startsWith("plutil ") ? 1_500 : 0);
  await assert.rejects(s.write("NEW_PLIST"), /still loaded with a different definition/);
  assert.equal(s.labelPrints(), 1);
  assert.equal(s.plutils().length, 1);
  assert.equal(s.sleeps.length, 0);
  assert.equal(s.content(), "OLD_PLIST");
});

test("Mac write accepts not found from a probe that started inside the grace and ended after it", async (t) => {
  let printIndex = 0;
  const s = setup(t, f => [loaded(f, f.argsOld), f.absent], undefined,
    call => isLabelPrint(call) && ++printIndex === 2 ? 2_000 : 0);
  await s.write("NEW_PLIST");
  assert.equal(s.content(), "NEW_PLIST");
  assert.equal(s.labelPrints(), 2);
  assert.deepEqual(s.sleeps, [100]);
  assert.equal(s.tick(), 2_100);
  s.noTemp();
});

test("Mac write default clock is monotonic real time", async () => {
  const before = realMacWriteClock.now();
  await realMacWriteClock.sleep(5);
  assert.ok(realMacWriteClock.now() >= before + 4);
});

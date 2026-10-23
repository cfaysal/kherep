// #677: a scripted launchd host for upgrade and rollback on the real MacServiceAdapter. launchd's job table, the process
// table and the daemon record are modelled; the plist is a real file. One fake clock drives the stop proof and the
// adapter; signals are recorded and end the modelled process. Nothing reaches a real launchctl, ps or process.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type test from "node:test";

import { nodePaths } from "./config.mts";
import type { DaemonState } from "./daemon-state.mts";
import { freshMacDefinition, managedArguments } from "./service-definitions.mts";
import type { LifecycleDependencies } from "./service-lifecycle.mts";
import { MacServiceAdapter } from "./service-platform-mac.mts";
import type { MacCommand, MacCommandResult } from "./service-platform-mac-native.mts";
import { snapshotDigests, writeServiceReceipt } from "./service-records.mts";
import type { ServiceBinding } from "./service-types.mts";

const LSTART = "Thu Oct 23 10:00:00 2026";
const STARTED_AT = new Date(Date.parse(LSTART)).toISOString();
const result = (status: number, stdout = "", stderr = ""): MacCommandResult => ({ status, stdout, stderr });
// "normal": bootout ends the job and its process; "unlisted-alive": #677; "listed-alive": launchd still stopping it.
export type Bootout = "normal" | "unlisted-alive" | "listed-alive";

export async function macHost(t: test.TestContext) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-mac-transaction-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const file = path.join(home, "Library", "LaunchAgents", "org.kherep.synthetic.transaction.plist");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const label = path.basename(file, ".plist");
  const pin = (char: string) => ({ root: path.join(root, `pin-${char}`), commit: char.repeat(40), digest: char.repeat(64), kind: "pin" as const, verified: true });
  const old: ServiceBinding = { serviceName: label, platform: "darwin", workspace: path.join(root, "work"), configRoot: root,
    nodeExecutable: process.execPath, source: pin("a") };
  const candidate: ServiceBinding = { ...old, source: pin("b") };
  for (const binding of [old, candidate]) fs.mkdirSync(binding.source.root, { recursive: true });
  const argsOf = (binding: ServiceBinding) => [binding.nodeExecutable, ...managedArguments(binding)];
  fs.writeFileSync(file, `PLIST:${JSON.stringify(freshMacDefinition(old))}`, { mode: 0o600 });
  const stat = fs.lstatSync(file);
  const uid = stat.uid;

  let tick = 0, nextPid = 4242;
  const processes = new Map<number, { args: string[]; diesAt?: number }>();
  const alive = (pid: unknown): boolean => {
    const entry = typeof pid === "number" ? processes.get(pid) : undefined;
    return entry !== undefined && (entry.diesAt === undefined || tick < entry.diesAt);
  };
  let job: { args: string[]; pid?: number } | null = null;
  let daemon: DaemonState | null = null;
  // inventoryDelay: extra ticks for a full `ps -axo` inventory that starts at `tick`; inventoryUnreadable: that inventory
  // fails; foreignAfterTerm: the pid reads as another program once it received SIGTERM; termExit < 0: SIGTERM is ignored.
  const options = { bootout: "normal" as Bootout, termExit: 2_000, printDelay: 0, inventoryDelay: (_tick: number) => 0,
    inventoryUnreadable: (_tick: number) => false, foreignAfterTerm: false };
  const calls: Array<{ tick: number; call: string }> = [];
  const signals: Array<{ pid: number; signal: string; tick: number }> = [];
  const launch = (args: string[]) => {
    const pid = nextPid++;
    processes.set(pid, { args });
    job = { args, pid };
    const source = args.join(" ") === argsOf(candidate).join(" ") ? candidate.source : old.source;
    daemon = { pid, startedAt: STARTED_AT, connectedAt: new Date(Date.parse(STARTED_AT) + 1_000).toISOString(), source,
      service: { name: label, platform: "darwin" } };
  };
  launch(argsOf(old));
  const printJob = (current: { args: string[]; pid?: number }) => `gui/${uid}/${label} = {\n\tpath = ${file}\n\ttype = LaunchAgent\n`
    + `\tstate = running\n\tprogram = ${current.args[0]}\n\tworking directory = ${old.workspace}\n`
    + `\targuments = {\n${current.args.map(value => `\t\t${value}\n`).join("")}\t}\n`
    + `\tinherited environment = {\n\t}\n\tdefault environment = {\n\t}\n\tenvironment = {\n\t}\n${current.pid ? `\tpid = ${current.pid}\n` : ""}}\n`;
  const living = () => [...processes].filter(([pid]) => alive(pid));
  const run: MacCommand = (command, argv) => {
    const call = [command, ...argv].join(" ");
    calls.push({ tick, call });
    if (command === "launchctl" && argv[0] === "print" && argv[1] === `gui/${uid}/${label}`) {
      tick += options.printDelay;
      if (job?.pid !== undefined && !alive(job.pid)) job = null; // launchd reaps a job whose process ended
      return job ? result(0, printJob(job)) : result(113, "", `Bad request.\nCould not find service "${label}" in domain for user gui: ${uid}\n`);
    }
    if (command === "launchctl" && argv[0] === "print") return result(0, `gui/${uid} = {\n}\n`);
    if (command === "launchctl" && argv[0] === "getenv") return result(1);
    if (command === "launchctl" && argv[0] === "bootout") {
      const pid = job?.pid;
      if (options.bootout !== "listed-alive") job = null;
      if (options.bootout === "normal" && pid !== undefined) processes.delete(pid);
      return result(0);
    }
    if (command === "launchctl" && argv[0] === "bootstrap") {
      launch((JSON.parse(fs.readFileSync(argv[2], "utf8").slice("PLIST:".length)) as { ProgramArguments: string[] }).ProgramArguments);
      return result(0);
    }
    if (command === "plutil" && argv[1] === "xml1") return result(0, `PLIST:${fs.readFileSync(argv.at(-1)!, "utf8")}`);
    if (command === "plutil") return result(0, fs.readFileSync(argv.at(-1)!, "utf8").slice("PLIST:".length));
    if (command === "/bin/ls") return result(0, "-rw------- 1 operator staff 1 Oct 23 10:00 synthetic.plist\n");
    if (command === "ps" && argv[0] === "-axo") return result(0, living().map(([pid]) => `${pid} 1\n`).join(""));
    if (command === "ps" && argv[2] === "pid=,uid=,command=") return result(0, `1 0 /sbin/launchd\n${living().map(([pid, p]) => `${pid} ${uid} ${p.args.join(" ")}\n`).join("")}`);
    if (command === "ps" && argv.includes("-axo")) {
      const started = tick;
      tick += options.inventoryDelay(started);
      if (options.inventoryUnreadable(started)) return result(1, "", "synthetic unreadable");
      return result(0, `1 0 1 0 ${LSTART} /sbin/launchd\n${living().map(([pid, p]) => `${pid} 1 ${pid} ${uid} ${LSTART} ${p.args.join(" ")}\n`).join("")}`);
    }
    const pid = Number(argv.at(-1) === "lstart=,uid=,pgid=,ppid=,command=" ? argv[2] : argv.at(-1));
    const foreign = options.foreignAfterTerm && signals.some(item => item.pid === pid && item.signal === "SIGTERM");
    if (command === "ps" && argv.includes("-p")) {
      return alive(pid) ? result(0, `${LSTART} ${uid} ${pid} 1 ${foreign ? "/usr/bin/foreign --task" : processes.get(pid)!.args.join(" ")}\n`) : result(1);
    }
    if (command === "/usr/bin/osascript") return alive(pid) ? result(0, `${process.execPath}\n`) : result(1);
    return result(1, "", "unexpected synthetic command");
  };
  const clock = { now: () => tick, sleep: async (ms: number) => { tick += ms; } };
  const adapter = new MacServiceAdapter(path.join(root, "control-plane", "service"), home, uid, stat.gid, run, clock, (pid, signal) => {
    signals.push({ pid, signal, tick });
    const entry = processes.get(pid);
    if (entry && signal === "SIGTERM" && options.termExit >= 0) entry.diesAt = tick + options.termExit;
  });
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  writeServiceReceipt(paths, { version: 1, binding: old, ...snapshotDigests((await adapter.read(old))!), activatedAt: STARTED_AT });
  const deps: LifecycleDependencies = { paths, adapter, clock, sleep: clock.sleep, pidAlive: alive, readDaemonState: () => daemon,
    verifySource: () => true, reportAdmissionWait: () => {} };
  return { root, file, old, candidate, adapter, deps, paths, calls, signals, options, alive, tick: () => tick,
    bootoutTick: () => calls.filter(item => item.call.startsWith("launchctl bootout ")).at(-1)?.tick ?? Number.NaN,
    daemonPid: () => (daemon as DaemonState | null)?.pid, inode: () => fs.statSync(file).ino, bytes: () => fs.readFileSync(file, "utf8") };
}

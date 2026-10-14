import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  adoptMacDefinition, freshMacDefinition, legacyDaemonArguments, managedArguments, retargetMacDefinition, validateMacExecutionFields,
} from "./service-definitions.mts";
import {
  MAC_EXECUTABLE_PROBE, PID_PATH_JXA, attestMacLaunchAgent, macFileSecurity, probeMacLaunchAgent, readMacPlist,
  runMacCommand, sameMacLaunchAgent,
  type MacCommand, type MacLaunchAgentProbe,
} from "./service-platform-mac-native.mts";
import { attestMacNoContextStop } from "./service-platform-mac-stop.mts";
import type { NativeServiceSnapshot, ServiceAdapter, ServiceBinding, ServiceStopContext } from "./service-types.mts";

export { MAC_EXECUTABLE_PROBE, macAclAbsent } from "./service-platform-mac-native.mts";

export function validateServiceName(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(value)) throw new Error("invalid service name");
  return value;
}

export const launchTarget = (uid: number, label: string): string => `gui/${uid}/${validateServiceName(label)}`;

function checked(run: MacCommand, file: string, args: string[]): string {
  const result = run(file, args);
  if (result.status !== 0) throw new Error(`${path.basename(file)} failed for the selected user service`);
  return result.stdout;
}

export class MacServiceAdapter implements ServiceAdapter {
  readonly platform = "darwin" as const;
  readonly #uid: number;
  readonly #gid: number;
  readonly #agents: string;
  readonly #scratch: string;
  readonly #run: MacCommand;

  constructor(serviceRoot: string, home = os.homedir(), uid = process.getuid?.(), gid = process.getgid?.(), run = runMacCommand) {
    if (uid === undefined || gid === undefined) throw new Error("current macOS user identity is unavailable");
    this.#uid = uid; this.#gid = gid;
    this.#agents = path.join(home, "Library", "LaunchAgents");
    this.#scratch = path.join(serviceRoot, "scratch"); this.#run = run;
  }

  #file(name: string): string { return path.join(this.#agents, `${validateServiceName(name)}.plist`); }
  #probe(binding: ServiceBinding): MacLaunchAgentProbe {
    return probeMacLaunchAgent(this.#run, this.#uid, validateServiceName(binding.serviceName));
  }

  #safeEnvironment(): void {
    if (Object.keys(process.env).some(key => /^(?:NODE_OPTIONS|NODE_PATH)$/i.test(key))) {
      throw new Error("host has execution-affecting Node environment variables");
    }
    for (const key of ["NODE_OPTIONS", "NODE_PATH"]) {
      const value = this.#run("launchctl", ["getenv", key]);
      if (value.status === 0 && value.stdout.trim()) throw new Error("launchd has execution-affecting Node environment variables");
      if (value.status !== 0 && value.status !== 1) throw new Error("launchd environment could not be verified");
    }
  }

  #toPlist(value: Record<string, unknown>): Buffer {
    fs.mkdirSync(this.#scratch, { recursive: true, mode: 0o700 });
    const input = path.join(this.#scratch, `plist-${process.pid}-${Date.now()}.json`);
    try {
      fs.writeFileSync(input, JSON.stringify(value), { mode: 0o600 });
      return Buffer.from(checked(this.#run, "plutil", ["-convert", "xml1", "-o", "-", "--", input]));
    } finally { fs.rmSync(input, { force: true }); }
  }

  async currentUser(): Promise<string> { return os.userInfo().username; }

  async read(binding: ServiceBinding): Promise<NativeServiceSnapshot | null> {
    if (binding.taskPath) throw new Error("task paths apply only to Windows Scheduled Tasks");
    const serviceName = binding.serviceName;
    const file = this.#file(serviceName);
    const before = this.#probe(binding);
    attestMacLaunchAgent(before, file);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) {
      if (before.kind === "loaded") throw new Error("LaunchAgent loaded definition is unavailable");
      const after = this.#probe(binding);
      if (!sameMacLaunchAgent(before, after)) throw new Error("LaunchAgent loaded identity changed during readback");
      return null;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("LaunchAgent definition is not a regular file");
    const definition = fs.readFileSync(file);
    const mac = readMacPlist(this.#run, file);
    attestMacLaunchAgent(before, file, mac);
    const metadata = macFileSecurity(file, this.#run);
    const after = this.#probe(binding);
    if (!sameMacLaunchAgent(before, after)) throw new Error("LaunchAgent loaded identity changed during readback");
    attestMacLaunchAgent(after, file, mac);
    let currentDefinition: Buffer;
    try { currentDefinition = fs.readFileSync(file); }
    catch { throw new Error("LaunchAgent configured definition changed during readback"); }
    if (!definition.equals(currentDefinition)) throw new Error("LaunchAgent configured definition changed during readback");
    if (!metadata.equals(macFileSecurity(file, this.#run))) {
      throw new Error("LaunchAgent configured security changed during readback");
    }
    const pid = after.kind === "loaded" ? after.pid : undefined;
    return { definition, security: metadata, running: pid ? true : after.kind === "absent" ? false : "unknown",
      ...(pid ? { pid } : {}), mac };
  }

  async fresh(binding: ServiceBinding): Promise<Buffer> {
    this.#safeEnvironment();
    return this.#toPlist(freshMacDefinition(binding));
  }
  async freshSecurity(_binding: ServiceBinding): Promise<Buffer> {
    return Buffer.from(JSON.stringify({ mode: 0o600, uid: this.#uid, gid: this.#gid, acl: "absent" }));
  }

  async adoptionNode(snapshot: NativeServiceSnapshot): Promise<string> {
    const executable = Array.isArray(snapshot.mac?.ProgramArguments) ? snapshot.mac.ProgramArguments[0] : undefined;
    if (typeof executable !== "string" || !path.isAbsolute(executable)) throw new Error("LaunchAgent Node executable is unavailable");
    return executable;
  }

  async adoptionSourceRoot(snapshot: NativeServiceSnapshot): Promise<string> {
    const args = snapshot.mac?.ProgramArguments;
    const cli = Array.isArray(args) ? args[1] : undefined;
    if (typeof cli !== "string" || !path.isAbsolute(cli)) throw new Error("LaunchAgent legacy source root is unavailable");
    const root = path.resolve(path.dirname(cli), "..", "..", "..");
    if (path.join(root, "modules", "control-plane", "node", "cli.mts") !== path.resolve(cli)) {
      throw new Error("LaunchAgent legacy source root is unavailable");
    }
    return root;
  }
  async adoptionLogFile(_snapshot: NativeServiceSnapshot): Promise<undefined> { return undefined; }

  async adopted(snapshot: NativeServiceSnapshot, binding: ServiceBinding, priorSourceRoot: string): Promise<Buffer> {
    this.#safeEnvironment();
    if (!snapshot.mac) throw new Error("LaunchAgent property list was not parsed");
    const own = JSON.parse(snapshot.security.toString("utf8")) as { mode: number; uid: number };
    const full = own as { mode: number; uid: number; gid: number };
    if (full.uid !== this.#uid || full.gid !== this.#gid || (full.mode & 0o022) !== 0) {
      throw new Error("LaunchAgent has foreign ownership or writable permissions");
    }
    return this.#toPlist(adoptMacDefinition(snapshot.mac, binding, this.#uid, priorSourceRoot));
  }

  async retargeted(snapshot: NativeServiceSnapshot, binding: ServiceBinding): Promise<Buffer> {
    this.#safeEnvironment();
    if (!snapshot.mac) throw new Error("LaunchAgent property list was not parsed");
    return this.#toPlist(retargetMacDefinition(snapshot.mac, binding));
  }

  async validateManaged(snapshot: NativeServiceSnapshot, binding: ServiceBinding): Promise<void> {
    this.#safeEnvironment();
    const expected = [binding.nodeExecutable, ...managedArguments(binding)];
    if (!snapshot.mac || snapshot.mac.Label !== binding.serviceName
      || JSON.stringify(snapshot.mac.ProgramArguments) !== JSON.stringify(expected)) throw new Error("LaunchAgent binding does not match the managed source");
    validateMacExecutionFields(snapshot.mac, binding);
    const env = snapshot.mac.EnvironmentVariables as Record<string, unknown> | undefined;
    if (env && Object.keys(env).some(key => /^(?:NODE_OPTIONS|NODE_PATH)$/i.test(key))) throw new Error("LaunchAgent has execution-affecting environment");
  }

  async processOwned(pid: number, binding: ServiceBinding, startedAt: string, sourceRoot = binding.source.root): Promise<boolean> {
    const native = this.#probe(binding);
    if (native.kind === "absent") return false;
    try { attestMacLaunchAgent(native, this.#file(binding.serviceName), undefined, pid); } catch { return false; }
    const started = this.#run("ps", ["-ww", "-p", String(pid), "-o", "lstart="]);
    const uid = this.#run("ps", ["-p", String(pid), "-o", "uid="]);
    const argv = this.#run("ps", ["-ww", "-p", String(pid), "-o", "command="]);
    const executable = this.#run(MAC_EXECUTABLE_PROBE, ["-l", "JavaScript", "-e", PID_PATH_JXA, String(pid)]);
    if (started.status !== 0 || uid.status !== 0 || argv.status !== 0 || executable.status !== 0
      || Number(uid.stdout.trim()) !== this.#uid) return false;
    const actualExecutable = executable.stdout.trim();
    if (!path.isAbsolute(actualExecutable) || actualExecutable.includes("\0")) return false;
    let actualReal: string;
    let expectedReal: string;
    try { actualReal = fs.realpathSync.native(actualExecutable); expectedReal = fs.realpathSync.native(binding.nodeExecutable); }
    catch { return false; }
    if (actualReal !== expectedReal) return false;
    const created = Date.parse(started.stdout.trim());
    const processCommand = argv.stdout.trim();
    const expected = [[binding.nodeExecutable, ...managedArguments(binding)], [binding.nodeExecutable, ...legacyDaemonArguments(binding, sourceRoot)]];
    return expected.some(argv => processCommand === argv.join(" "))
      && Number.isFinite(created) && Math.abs(Date.parse(startedAt) - created) <= 60_000;
  }

  async preflightStop(binding: ServiceBinding, expected: ServiceStopContext | undefined): Promise<void> {
    if (!expected) {
      attestMacNoContextStop(this.#run, this.#uid, binding, this.#file(binding.serviceName));
      return;
    }
    const pid = expected.pid;
    const native = this.#probe(binding);
    if (native.kind === "absent") throw new Error("selected LaunchAgent process is unavailable");
    const file = this.#file(binding.serviceName);
    attestMacLaunchAgent(native, file, undefined, pid);
    attestMacLaunchAgent(native, file, readMacPlist(this.#run, file), pid);
    const result = this.#run("ps", ["-axo", "pid=", "-o", "ppid="]);
    if (result.status !== 0) throw new Error("STOP_UNKNOWN_DESCENDANTS");
    const rows = result.stdout.split(/\r?\n/).map(line => line.trim().split(/\s+/).map(Number))
      .filter((row): row is [number, number] => row.length === 2 && row.every(Number.isInteger));
    const seen = new Set([pid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [child, parent] of rows) if (seen.has(parent) && !seen.has(child)) { seen.add(child); changed = true; }
    }
    if (seen.size > 1) throw new Error("STOP_BLOCKED_NATIVE_DESCENDANTS");
  }

  async write(binding: ServiceBinding, definition: Buffer, metadata: Buffer): Promise<void> {
    const serviceName = binding.serviceName;
    const own = JSON.parse(metadata.toString("utf8")) as { mode: number; uid: number; gid: number; acl?: string };
    if (own.uid !== this.#uid || own.gid !== this.#gid || (own.mode & 0o022) !== 0 || own.acl !== "absent") {
      throw new Error("LaunchAgent security metadata is unsafe");
    }
    fs.mkdirSync(this.#agents, { recursive: true, mode: 0o700 });
    const file = this.#file(serviceName);
    const existing = fs.lstatSync(file, { throwIfNoEntry: false });
    if (existing && !macFileSecurity(file, this.#run).equals(metadata)) throw new Error("LaunchAgent security metadata changed before write");
    const temp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, definition, { mode: own.mode, flag: "wx" });
      fs.chmodSync(temp, own.mode);
      if (!macFileSecurity(temp, this.#run).equals(metadata)) throw new Error("LaunchAgent temporary security metadata differs");
      fs.renameSync(temp, file);
    } finally { fs.rmSync(temp, { force: true }); }
  }

  async remove(binding: ServiceBinding): Promise<void> { fs.rmSync(this.#file(binding.serviceName), { force: true }); }
  async stop(binding: ServiceBinding, expected: ServiceStopContext | undefined): Promise<void> {
    const serviceName = binding.serviceName;
    if (!expected) {
      const native = attestMacNoContextStop(this.#run, this.#uid, binding, this.#file(serviceName));
      if (native.kind === "absent") return;
      const result = this.#run("launchctl", ["bootout", launchTarget(this.#uid, serviceName)]);
      if (result.status !== 0) throw new Error("launchctl could not prove the selected service stopped");
      return;
    }
    const native = this.#probe(binding);
    if (native.kind === "absent") {
      throw new Error("selected LaunchAgent process is unavailable");
    }
    const file = this.#file(serviceName);
    attestMacLaunchAgent(native, file, undefined, expected.pid);
    attestMacLaunchAgent(native, file, readMacPlist(this.#run, file), expected.pid);
    const result = this.#run("launchctl", ["bootout", launchTarget(this.#uid, serviceName)]);
    if (result.status !== 0) throw new Error("launchctl could not prove the selected service stopped");
  }
  async start(binding: ServiceBinding): Promise<void> {
    const serviceName = binding.serviceName;
    checked(this.#run, "launchctl", ["bootstrap", `gui/${this.#uid}`, this.#file(serviceName)]);
  }
}

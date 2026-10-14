import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  adoptMacDefinition, freshMacDefinition, legacyDaemonArguments, managedArguments, retargetMacDefinition, validateMacExecutionFields,
} from "./service-definitions.mts";
import type { NativeServiceSnapshot, ServiceAdapter, ServiceBinding, ServiceStopContext } from "./service-types.mts";

export function validateServiceName(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(value)) throw new Error("invalid service name");
  return value;
}

export const launchTarget = (uid: number, label: string): string => `gui/${uid}/${validateServiceName(label)}`;

type Result = { status: number | null; stdout: string; stderr: string; error?: Error };
const PID_PATH_JXA = "ObjC.import('Foundation');ObjC.bindFunction('proc_pidpath',['int',['int','void *','unsigned int']]);"
  + "function run(argv){var b=$.NSMutableData.dataWithLength(4096);var n=$.proc_pidpath(Number(argv[0]),b.mutableBytes,4096);"
  + "if(!(n>0&&n<4096))throw Error('path unavailable');b.length=n;"
  + "return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(b,$.NSUTF8StringEncoding));}";
export const MAC_EXECUTABLE_PROBE = "/usr/bin/osascript";

function command(file: string, args: string[], timeout = 15_000, env = process.env): Result {
  const result = spawnSync(file, args, { encoding: "utf8", env, windowsHide: true, timeout, stdio: ["ignore", "pipe", "pipe"] });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", ...(result.error ? { error: result.error } : {}) };
}

function checked(file: string, args: string[]): string {
  const result = command(file, args);
  if (result.status !== 0) throw new Error(`${path.basename(file)} failed for the selected user service`);
  return result.stdout;
}

export function macAclAbsent(output: string): boolean {
  const lines = output.split(/\r?\n/u).filter(line => line.length > 0);
  if (!lines.length) throw new Error("LaunchAgent ACL inventory is empty");
  return !lines.some(line => /^\s*\d+:\s/u.test(line));
}

function attestNoAcl(file: string): void {
  const inventory = command("/bin/ls", ["-lde", file], 15_000, { ...process.env, LANG: "C", LC_ALL: "C" });
  if (inventory.status !== 0) throw new Error("LaunchAgent ACL inventory is unavailable");
  if (!macAclAbsent(inventory.stdout)) throw new Error("LaunchAgent has an extended ACL");
}

function security(file: string): Buffer {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("LaunchAgent definition is not a regular file");
  attestNoAcl(file);
  return Buffer.from(JSON.stringify({ mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid, acl: "absent" }));
}

export class MacServiceAdapter implements ServiceAdapter {
  readonly platform = "darwin" as const;
  readonly #uid: number;
  readonly #gid: number;
  readonly #agents: string;
  readonly #scratch: string;

  constructor(serviceRoot: string, home = os.homedir(), uid = process.getuid?.(), gid = process.getgid?.()) {
    if (uid === undefined || gid === undefined) throw new Error("current macOS user identity is unavailable");
    this.#uid = uid;
    this.#gid = gid;
    this.#agents = path.join(home, "Library", "LaunchAgents");
    this.#scratch = path.join(serviceRoot, "scratch");
  }

  #file(name: string): string { return path.join(this.#agents, `${validateServiceName(name)}.plist`); }

  #safeEnvironment(): void {
    if (Object.keys(process.env).some(key => /^(?:NODE_OPTIONS|NODE_PATH)$/i.test(key))) {
      throw new Error("host has execution-affecting Node environment variables");
    }
    for (const key of ["NODE_OPTIONS", "NODE_PATH"]) {
      const value = command("launchctl", ["getenv", key]);
      if (value.status === 0 && value.stdout.trim()) throw new Error("launchd has execution-affecting Node environment variables");
      if (value.status !== 0 && value.status !== 1) throw new Error("launchd environment could not be verified");
    }
  }

  #toPlist(value: Record<string, unknown>): Buffer {
    fs.mkdirSync(this.#scratch, { recursive: true, mode: 0o700 });
    const input = path.join(this.#scratch, `plist-${process.pid}-${Date.now()}.json`);
    try {
      fs.writeFileSync(input, JSON.stringify(value), { mode: 0o600 });
      return Buffer.from(checked("plutil", ["-convert", "xml1", "-o", "-", "--", input]));
    } finally { fs.rmSync(input, { force: true }); }
  }

  async currentUser(): Promise<string> { return os.userInfo().username; }

  async read(binding: ServiceBinding): Promise<NativeServiceSnapshot | null> {
    if (binding.taskPath) throw new Error("task paths apply only to Windows Scheduled Tasks");
    const serviceName = binding.serviceName;
    const file = this.#file(serviceName);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("LaunchAgent definition is not a regular file");
    const definition = fs.readFileSync(file);
    const converted = command("plutil", ["-convert", "json", "-o", "-", "--", file]);
    if (converted.status !== 0) throw new Error("LaunchAgent property list has unsupported values");
    const mac = JSON.parse(converted.stdout) as Record<string, unknown>;
    const printed = command("launchctl", ["print", launchTarget(this.#uid, serviceName)]);
    const pid = printed.status === 0 ? /\bpid\s*=\s*(\d+)\b/.exec(printed.stdout)?.[1] : undefined;
    return { definition, security: security(file), running: pid ? true : "unknown", ...(pid ? { pid: Number(pid) } : {}), mac };
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
    const printed = command("launchctl", ["print", launchTarget(this.#uid, binding.serviceName)]);
    const nativePid = printed.status === 0 ? /\bpid\s*=\s*(\d+)\b/.exec(printed.stdout)?.[1] : undefined;
    if (Number(nativePid) !== pid) return false;
    const started = command("ps", ["-ww", "-p", String(pid), "-o", "lstart="]);
    const uid = command("ps", ["-p", String(pid), "-o", "uid="]);
    const argv = command("ps", ["-ww", "-p", String(pid), "-o", "command="]);
    const executable = command(MAC_EXECUTABLE_PROBE, ["-l", "JavaScript", "-e", PID_PATH_JXA, String(pid)]);
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

  async preflightStop(_binding: ServiceBinding, expected: ServiceStopContext | undefined): Promise<void> {
    if (!expected) throw new Error("selected LaunchAgent process is unavailable");
    const pid = expected.pid;
    const result = command("ps", ["-axo", "pid=", "-o", "ppid="]);
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
    if (existing && !security(file).equals(metadata)) throw new Error("LaunchAgent security metadata changed before write");
    const temp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, definition, { mode: own.mode, flag: "wx" });
      fs.chmodSync(temp, own.mode);
      if (!security(temp).equals(metadata)) throw new Error("LaunchAgent temporary security metadata differs");
      fs.renameSync(temp, file);
    } finally { fs.rmSync(temp, { force: true }); }
  }

  async remove(binding: ServiceBinding): Promise<void> { fs.rmSync(this.#file(binding.serviceName), { force: true }); }
  async stop(binding: ServiceBinding, _expected: ServiceStopContext | undefined): Promise<void> {
    const serviceName = binding.serviceName;
    const result = command("launchctl", ["bootout", launchTarget(this.#uid, serviceName)]);
    if (result.status !== 0) throw new Error("launchctl could not prove the selected service stopped");
  }
  async start(binding: ServiceBinding): Promise<void> {
    const serviceName = binding.serviceName;
    checked("launchctl", ["bootstrap", `gui/${this.#uid}`, this.#file(serviceName)]);
  }
}

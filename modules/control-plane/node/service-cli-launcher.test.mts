import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { nodePaths, writeConfig } from "./config.mts";
import type { DaemonState } from "./daemon-state.mts";
import { launcherPath, resolveLauncher } from "./launcher.mts";
import { launcherBytes, stubCli, tempRoot } from "./launcher-fixture.mts";
import { runService } from "./service-cli.mts";
import { readServiceReceipt } from "./service-records.mts";
import type { NativeServiceSnapshot, ServiceAdapter, ServiceBinding, ServicePlatform } from "./service-types.mts";

// Issue #436: service install, upgrade and rollback write the stable launcher,
// whose bytes never change while its resolution follows the receipt's pin.

const supported = process.platform === "win32" || process.platform === "darwin";

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

// A clean checkout whose Control Plane CLI is the stub naming `marker`.
function commitStub(repo: string, marker: string): string {
  fs.mkdirSync(path.join(repo, "modules", "control-plane", "node"), { recursive: true });
  fs.writeFileSync(path.join(repo, "modules", "control-plane", "node", "cli.mts"), stubCli(marker));
  fs.writeFileSync(path.join(repo, "package.json"), "{}\n");
  git(repo, "add", ".");
  const parent = spawnSync("git", ["-C", repo, "rev-parse", "--verify", "HEAD"], { encoding: "utf8", windowsHide: true });
  const commit = git(repo, "-c", "user.name=Kherep Fixture", "-c", "user.email=fixture@example.invalid", "commit-tree",
    git(repo, "write-tree"), ...(parent.status === 0 ? ["-p", parent.stdout.trim()] : []), "-m", marker);
  git(repo, "update-ref", "HEAD", commit);
  return commit;
}

// A native service manager in memory: a started service is a "daemon" that is
// alive, authenticated and runs the binding's source, as the transaction checks.
class FakeService implements ServiceAdapter {
  readonly platform: ServicePlatform;
  snapshot: NativeServiceSnapshot | null = null;
  state: DaemonState | null = null;
  alive = new Set<number>();
  private nextPid = 100;
  constructor(platform: ServicePlatform) { this.platform = platform; }
  async currentUser() { return "EXAMPLE\\operator"; }
  async read() {
    return this.snapshot && { ...this.snapshot, definition: Buffer.from(this.snapshot.definition), security: Buffer.from(this.snapshot.security) };
  }
  async fresh(binding: ServiceBinding) { return Buffer.from(`definition ${binding.source.commit}`); }
  async freshSecurity() { return Buffer.from("security"); }
  async retargeted(_snapshot: NativeServiceSnapshot, binding: ServiceBinding) { return Buffer.from(`definition ${binding.source.commit}`); }
  async adopted(): Promise<Buffer> { throw new Error("adoption is not part of this test"); }
  async adoptionNode(): Promise<string> { throw new Error("adoption is not part of this test"); }
  async adoptionSourceRoot(): Promise<string> { throw new Error("adoption is not part of this test"); }
  async adoptionLogFile() { return undefined; }
  async validateManaged() {}
  async processOwned(pid: number) { return this.alive.has(pid); }
  async preflightStop() {}
  async write(_binding: ServiceBinding, definition: Buffer, security: Buffer) {
    this.snapshot = { definition: Buffer.from(definition), security: Buffer.from(security), running: false };
  }
  async remove() { this.snapshot = null; }
  async stop() {
    if (this.snapshot) this.snapshot.running = false;
    if (this.state) this.alive.delete(this.state.pid);
  }
  async start(binding: ServiceBinding) {
    if (this.snapshot) this.snapshot.running = true;
    const pid = this.nextPid++;
    const at = new Date().toISOString();
    this.alive.add(pid);
    this.state = { pid, startedAt: at, connectedAt: at, source: binding.source,
      service: { name: binding.serviceName, platform: binding.platform, taskPath: binding.taskPath } };
  }
}

function enrolledHost(t: test.TestContext) {
  const root = tempRoot(t, "kherep-service-launcher-");
  const paths = nodePaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  writeConfig(paths.config, { version: 1, controlUrl: "https://control.example.com", nodeId: "00000000-0000-4000-8000-000000000001",
    name: "fixture", publicKey: "synthetic", privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: new Date().toISOString() });
  const workspace = path.join(root, "workspace");
  const repo = path.join(path.dirname(root), "checkout");
  fs.mkdirSync(workspace);
  fs.mkdirSync(repo);
  git(repo, "init", "-q");
  const service = new FakeService(process.platform as ServicePlatform);
  const dependencies = { root, adapterFor: () => service, lifecycle: { readDaemonState: () => service.state,
    pidAlive: (pid: unknown) => service.alive.has(pid as number), sleep: async () => {}, timeoutMs: 50 } };
  const runCommand = async (argv: string[]): Promise<Record<string, unknown>> => {
    const original = console.log;
    let output = "";
    console.log = (value: unknown) => { output = String(value); };
    try { assert.equal(await runService(argv, dependencies), 0); } finally { console.log = original; }
    return JSON.parse(output) as Record<string, unknown>;
  };
  // The real generated launcher, run as an agent runs it.
  const launch = () => {
    const result = spawnSync(process.execPath, [launcherPath(root), "msg", "send", "peer/session", "--", "a b"],
      { encoding: "utf8", windowsHide: true, env: { ...process.env, KHEREP_CONFIG_DIR: root } });
    return { status: result.status, out: result.stdout ? JSON.parse(result.stdout) as { pin: string; argv: string[] } : null };
  };
  return { root, paths, workspace, repo, run: runCommand, launch };
}

test("install, upgrade and rollback keep the launcher bytes while it follows the receipt's pin", { skip: !supported && "managed services exist only on macOS and Windows" }, async (t) => {
  const h = enrolledHost(t);
  const pinOf = () => readServiceReceipt(h.paths)!.binding.source.root;
  const commitA = commitStub(h.repo, "A");
  const install = await h.run(["install", "--workspace", h.workspace, "--source", h.repo]);
  assert.equal(install.launcher, "written");
  const bytes = launcherBytes(h.root);
  const pinA = pinOf();
  assert.equal(path.basename(pinA), commitA);
  assert.deepEqual(h.launch(), { status: 7, out: { pin: "A", argv: ["msg", "send", "peer/session", "--", "a b"] } });

  const commitB = commitStub(h.repo, "B");
  const upgrade = await h.run(["upgrade", "--source", h.repo]);
  assert.equal(upgrade.launcher, "unchanged");
  assert.deepEqual(launcherBytes(h.root), bytes);
  assert.equal(path.basename(pinOf()), commitB);
  assert.deepEqual(resolveLauncher(h.root), { ok: true, receipt: path.join(h.paths.dir, "service", "receipt.json"),
    pin: pinOf(), cli: path.join(pinOf(), "modules", "control-plane", "node", "cli.mts"), nodeExecutable: process.execPath });
  assert.equal(h.launch().out?.pin, "B");

  const rollback = await h.run(["rollback"]);
  assert.equal(rollback.launcher, "unchanged");
  assert.deepEqual(launcherBytes(h.root), bytes);
  assert.equal(pinOf(), pinA);
  assert.deepEqual(h.launch(), { status: 7, out: { pin: "A", argv: ["msg", "send", "peer/session", "--", "a b"] } });
});

test("a launcher that cannot be written is reported as failed without undoing the activation", { skip: !supported && "managed services exist only on macOS and Windows" }, async (t) => {
  const h = enrolledHost(t);
  commitStub(h.repo, "A");
  fs.writeFileSync(path.join(h.root, "bin"), "not a directory\n");
  const install = await h.run(["install", "--workspace", h.workspace, "--source", h.repo]);
  assert.equal(install.ok, true);
  assert.equal(install.launcher, "failed");
  assert.notEqual(readServiceReceipt(h.paths), null, "the receipt of the activation stays");
  assert.equal(fs.readFileSync(path.join(h.root, "bin"), "utf8"), "not a directory\n");
});

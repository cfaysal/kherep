import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { listenerDir } from "./autonomy.mts";
import { nodePaths, writeConfig, type NodePaths } from "./config.mts";
import { daemonStateFile } from "./daemon-state.mts";
import { runDoctor, type DoctorDeps } from "./doctor.mts";
import { generateIdentity, writePrivateKey } from "./identity.mts";

// Issue #215. Every check is driven through runDoctor against a synthetic
// host: config directory, runtime config files and checkout in a temp dir.
const NODE_ID = "00000000-0000-4000-8000-0000000000aa";
const LIVE_PID = 4242;
const HOOKS = (repo: string) => path.join(repo, "modules", "control-plane", "node");

interface Host { root: string; paths: NodePaths; repo: string; deps: DoctorDeps; pem: string }

function host(t: test.TestContext): Host {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-doctor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(path.join(root, "config"));
  fs.mkdirSync(paths.dir, { recursive: true });
  const identity = generateIdentity();
  writePrivateKey(paths.privateKey, identity);
  writeConfig(paths.config, { version: 1, controlUrl: "https://control.example.invalid", nodeId: NODE_ID, name: "synthetic",
    publicKey: identity.publicKey, privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: new Date(0).toISOString() });
  fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: ["node.status"],
    wake: { enabled: true, sessions: ["build"] }, sessions: { enabled: true, workspaceRoots: ["/synthetic/work"], runtimes: ["claude"] } }));
  fs.writeFileSync(daemonStateFile(paths), JSON.stringify({ pid: LIVE_PID, startedAt: "2026-10-04T10:00:00.000Z",
    connectedAt: "2026-10-04T10:00:01.000Z" }));
  const repo = path.join(root, "checkout");
  fs.mkdirSync(HOOKS(repo), { recursive: true });
  for (const hook of ["deliver-hook.mts", "wake-hook.mts"]) fs.writeFileSync(path.join(HOOKS(repo), hook), "");
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ version: "9.8.7" }));
  const claude = path.join(root, "claude");
  const codex = path.join(root, "codex");
  fs.mkdirSync(claude);
  fs.mkdirSync(codex);
  writeHooks(claude, codex, repo);
  const deps: DoctorDeps = {
    paths, repoRoot: repo, claudeConfigDir: claude, codexHome: codex, now: () => Date.parse("2026-10-04T12:00:00.000Z"),
    pidAlive: (pid) => pid === LIVE_PID,
    fetch: async () => Response.json({ ok: true, service: "kherep-control", version: "9.8.7", commit: null, remoteMcp: true }),
    find: (name) => (name === "claude" ? "/synthetic/bin/claude" : null),
    versionOf: async (name) => (name === "claude" ? "2.1.300 (Claude Code)" : null),
  };
  return { root, paths, repo, deps, pem: fs.readFileSync(paths.privateKey, "utf8") };
}

// As the installers and runtimes write them: Claude settings JSON and Codex TOML strings.
function writeHooks(claudeDir: string, codexDir: string, repo: string, codexRepo = repo): void {
  const command = (hook: string, extra: string) => `node "${path.join(HOOKS(repo), hook)}"${extra}`;
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [
    { type: "command", command: command("deliver-hook.mts", "") },
    { type: "command", command: command("wake-hook.mts", " --timeout 86400"), asyncRewake: true }] }] } }, null, 2)
    .replace(/\//g, "\\/")); // settings.json may spell "/" as "\/" (seen on a live host, 2026-10-04)
  const codexCommand = `"/usr/bin/node" "${path.join(HOOKS(codexRepo), "deliver-hook.mts")}" "--runtime" "codex"`;
  fs.writeFileSync(path.join(codexDir, "config.toml"), `[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(codexCommand)}\n`);
}

test("a healthy host passes every check and reports versions without secrets", async (t) => {
  const h = host(t);
  const report = await runDoctor({ ...h.deps,
    fetch: async () => Response.json({ ok: true, version: "9.8.7", commit: "0123abc", remoteMcp: true, token: "SYNTHETIC_SECRET" }) });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.version, "9.8.7");
  assert.deepEqual(report.checks.enrollment, { ok: true, enrolled: true, nodeId: NODE_ID, keyReadable: true });
  assert.deepEqual(report.checks.worker, { ok: true, reachable: true, status: 200, version: "9.8.7", commit: "0123abc", remoteMcp: true });
  assert.deepEqual(report.checks.policy.wake, { enabled: true, sessions: ["build"], codexApp: false });
  assert.deepEqual(report.checks.runtimes.claude, { installed: true, version: "2.1.300 (Claude Code)", configured: true, ready: "unknown" });
  assert.deepEqual(report.checks.hooks.claude, { present: true, deliver: 1, wake: 1, foreign: [] });
  assert.deepEqual(report.checks.hooks.codex, { present: true, deliver: 1, wake: 0, foreign: [] });
  assert.deepEqual(report.checks.listeners, { ok: true, live: 0, stale: 0 });
  const text = JSON.stringify(report);
  for (const secret of ["SYNTHETIC_SECRET", "PRIVATE KEY", h.pem.split("\n")[1]]) assert.equal(text.includes(secret), false);
});

test("enrollment fails without a node, without a readable key, with a foreign key or an invalid node.json", async (t) => {
  const h = host(t);
  fs.rmSync(h.paths.privateKey);
  let report = await runDoctor(h.deps);
  assert.deepEqual([report.ok, report.checks.enrollment.keyReadable], [false, false]);
  writePrivateKey(h.paths.privateKey, generateIdentity());
  report = await runDoctor(h.deps);
  assert.equal(report.checks.enrollment.ok, false);
  assert.match(String(report.checks.enrollment.detail), /does not match/);
  fs.writeFileSync(h.paths.config, "{");
  report = await runDoctor(h.deps);
  assert.deepEqual([report.checks.enrollment.ok, report.checks.worker.ok], [false, false]);
  fs.rmSync(h.paths.config);
  report = await runDoctor(h.deps);
  assert.equal(report.checks.enrollment.enrolled, false);
  assert.equal(report.checks.worker.detail, "needs an enrolled node");
});

test("the daemon check needs a recorded, running process whose last connection is authenticated", async (t) => {
  const h = host(t);
  const state = daemonStateFile(h.paths);
  fs.writeFileSync(state, JSON.stringify({ pid: 99, startedAt: "2026-10-04T10:00:00.000Z", connectedAt: "2026-10-04T10:00:01.000Z" }));
  assert.equal((await runDoctor(h.deps)).checks.daemon.alive, false);
  fs.writeFileSync(state, JSON.stringify({ pid: LIVE_PID, startedAt: "2026-10-04T10:00:00.000Z" }));
  const unconnected = (await runDoctor(h.deps)).checks.daemon;
  assert.deepEqual([unconnected.ok, unconnected.alive, unconnected.connectedAt], [false, true, null]);
  fs.writeFileSync(state, JSON.stringify({ pid: LIVE_PID, startedAt: "2026-10-04T10:00:00.000Z",
    connectedAt: "2026-10-04T10:00:01.000Z", disconnectedAt: "2026-10-04T11:00:00.000Z" }));
  const reconnecting = (await runDoctor(h.deps)).checks.daemon;
  assert.deepEqual([reconnecting.ok, reconnecting.disconnectedAt], [false, "2026-10-04T11:00:00.000Z"]);
  fs.writeFileSync(state, "{");
  assert.equal((await runDoctor(h.deps)).checks.daemon.detail, "daemon.json is unreadable");
  fs.rmSync(state);
  const report = await runDoctor(h.deps);
  assert.deepEqual([report.ok, report.checks.daemon.ok], [false, false]);
});

test("the Worker check fails when /health is unreachable, not 200 or not ok, and copies only known fields", async (t) => {
  const h = host(t);
  const worker = async (fetcher: typeof fetch) => (await runDoctor({ ...h.deps, fetch: fetcher })).checks.worker;
  assert.deepEqual(await worker(async () => { throw new Error("SYNTHETIC_NETWORK_DOWN"); }),
    { ok: false, reachable: false, detail: "the Worker did not answer /health" });
  assert.equal((await worker(async () => new Response("SYNTHETIC_BODY", { status: 503 }))).ok, false);
  const old = await worker(async () => Response.json({ ok: true, service: "kherep-control" }));
  assert.deepEqual([old.ok, old.version, old.remoteMcp], [true, null, null]);
  const notOk = await worker(async () => Response.json({ ok: false, version: 7 }));
  assert.deepEqual([notOk.ok, notOk.version], [false, null]);
});

test("the policy check fails on a malformed file and on a rejected wake section, and accepts the default", async (t) => {
  const h = host(t);
  fs.writeFileSync(h.paths.policy, JSON.stringify({ version: 1, allowedCommands: [], wake: { enabled: true, sessions: [] } }));
  let policy = (await runDoctor(h.deps)).checks.policy;
  assert.deepEqual([policy.ok, policy.wake], [false, { enabled: false, rejected: true }]);
  fs.writeFileSync(h.paths.policy, "not json");
  assert.equal((await runDoctor(h.deps)).checks.policy.ok, false);
  fs.rmSync(h.paths.policy);
  policy = (await runDoctor(h.deps)).checks.policy;
  assert.deepEqual([policy.ok, policy.source, policy.wake, policy.sessions], [true, "default", { enabled: false }, { enabled: false }]);
});

test("the runtime check fails without any runtime and when a configured runtime is missing or silent", async (t) => {
  const h = host(t);
  const runtimes = async (deps: Partial<DoctorDeps>) => (await runDoctor({ ...h.deps, ...deps })).checks.runtimes;
  assert.equal((await runtimes({ find: () => null })).ok, false);
  assert.equal((await runtimes({ versionOf: async () => null })).ok, false);
  fs.writeFileSync(h.paths.policy, JSON.stringify({ version: 1, allowedCommands: [], sessions: { enabled: true, workspaceRoots: ["/synthetic/work"], runtimes: ["claude", "codex"] } }));
  const missing = await runtimes({});
  assert.deepEqual([missing.ok, missing.codex], [false, { installed: false, version: null, configured: true, ready: "unknown" }]);
  fs.writeFileSync(h.paths.policy, JSON.stringify({ version: 1, allowedCommands: [] }));
  assert.equal((await runtimes({ versionOf: async () => null })).ok, true);
});

// Issue #222: readiness comes from the running daemon's daemon.json only.
test("the runtime check reports the running daemon's readiness record and ignores a dead daemon's", async (t) => {
  const h = host(t);
  const probedAt = "2026-10-04T11:55:00.000Z";
  const write = (pid: number) => fs.writeFileSync(daemonStateFile(h.paths), JSON.stringify({ pid, startedAt: "2026-10-04T10:00:00.000Z",
    connectedAt: "2026-10-04T10:00:01.000Z", readiness: { claude: { ready: false, cause: "sign-in", probedAt } } }));
  write(LIVE_PID);
  const live = (await runDoctor(h.deps)).checks.runtimes;
  assert.deepEqual([live.ok, live.claude], [false, { installed: true, version: "2.1.300 (Claude Code)", configured: true,
    ready: false, cause: "sign-in", probedAt, aged: true }]);
  write(99);
  const dead = (await runDoctor(h.deps)).checks.runtimes;
  assert.deepEqual([dead.ok, (dead.claude as { ready: unknown }).ready], [true, "unknown"]);
});

test("the hook check fails for another checkout, for no hooks and for an unreadable file", async (t) => {
  const h = host(t);
  const claude = h.deps.claudeConfigDir as string;
  const codex = h.deps.codexHome as string;
  const other = path.join(h.root, "old-checkout");
  writeHooks(claude, codex, h.repo, other);
  const hooks = (await runDoctor(h.deps)).checks.hooks;
  assert.equal(hooks.ok, false);
  assert.deepEqual(hooks.codex, { present: true, deliver: 0, wake: 0, foreign: [path.join(HOOKS(other), "deliver-hook.mts")] });
  fs.rmSync(path.join(claude, "settings.json"));
  fs.rmSync(path.join(codex, "config.toml"));
  const none = (await runDoctor(h.deps)).checks.hooks;
  assert.deepEqual([none.ok, none.detail], [false, "no delivery or wake hook is installed"]);
  fs.mkdirSync(path.join(claude, "settings.json"));
  assert.equal((await runDoctor(h.deps)).checks.hooks.detail, "a runtime configuration file is unreadable");
});

test("the listener check counts live and stale listener locks only", async (t) => {
  const h = host(t);
  const dir = listenerDir(h.paths);
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.parse("2026-10-04T12:00:00.000Z");
  const lock = (name: string, pid: number, startedAt: number) =>
    fs.writeFileSync(path.join(dir, name), JSON.stringify({ token: "t", pid, startedAt, event: "Stop" }));
  lock("live-session.json", LIVE_PID, now - 1_000);
  lock("dead-session.json", 99, now - 1_000);
  lock("old-session.json", LIVE_PID, now - 2 * 86_400_000);
  lock("live-session.turns.json", LIVE_PID, now);
  assert.deepEqual((await runDoctor(h.deps)).checks.listeners, { ok: true, live: 1, stale: 2 });
});

test("kherep-node doctor prints JSON and exits 1 on a host that is not enrolled", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-doctor-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cli = path.join(import.meta.dirname, "cli.mts");
  const result = spawnSync(process.execPath, [cli, "doctor"], { encoding: "utf8", timeout: 60_000,
    env: { ...process.env, KHEREP_CONFIG_DIR: root, CLAUDE_CONFIG_DIR: root, CODEX_HOME: root, HOME: root, PATH: "" } });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout) as { ok: boolean; checks: Record<string, { ok: boolean }> };
  assert.deepEqual([report.ok, report.checks.enrollment.ok, report.checks.daemon.ok], [false, false, false]);
});

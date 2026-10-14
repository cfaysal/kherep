import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { nodePaths } from "./config.mts";
import { acquireServiceLock } from "./service-records.mts";
import {
  beginServiceDrain, defaultServiceOwnerProbe, serviceAdmissionsIdle, serviceDrainFile, withServiceAdmission, type ServiceOwnerProbe,
} from "./service-drain.mts";

test("a service drain blocks new admissions and observes an admission that already holds a lease", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-service-drain-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  let releaseOperation!: () => void;
  let admitted!: () => void;
  const entered = new Promise<void>(resolve => { admitted = resolve; });
  const release = new Promise<void>(resolve => { releaseOperation = resolve; });
  const operation = withServiceAdmission(paths, async () => { admitted(); await release; });
  await entered;
  const endDrain = beginServiceDrain(paths);
  assert.equal(serviceAdmissionsIdle(paths), false);
  await assert.rejects(withServiceAdmission(paths, async () => {}), /draining new session admissions/);
  releaseOperation();
  await operation;
  assert.equal(serviceAdmissionsIdle(paths), true);
  endDrain();
});

test("a crashed controller drain and transaction lock are recovered only after owner provenance proves them stale", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-service-stale-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  const stale = { version: 1 as const, pid: 41, startedAt: "2026-10-14T10:00:00.000Z", owner: "operator" };
  const current = { version: 1 as const, pid: 42, startedAt: "2026-10-14T11:00:00.000Z", owner: "operator" };
  const probe: ServiceOwnerProbe = { current: () => current, active: (owner) => owner.pid === 42 ? true : false };
  fs.mkdirSync(path.dirname(serviceDrainFile(paths)), { recursive: true });
  fs.writeFileSync(serviceDrainFile(paths), JSON.stringify(stale));
  const endDrain = beginServiceDrain(paths, probe);
  assert.equal(JSON.parse(fs.readFileSync(serviceDrainFile(paths), "utf8")).pid, 42);
  assert.throws(() => beginServiceDrain(paths, probe), /already active/);
  endDrain();

  const lock = path.join(paths.dir, "service", "transaction.lock");
  fs.writeFileSync(lock, JSON.stringify(stale));
  const release = acquireServiceLock(paths, probe);
  assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).pid, 42);
  assert.throws(() => acquireServiceLock(paths, probe), /already active/);
  release();
});

test("an unreadable controller owner is UNKNOWN and is never removed as stale", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-service-unknown-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  const owner = { version: 1 as const, pid: 41, startedAt: "2026-10-14T10:00:00.000Z", owner: "operator" };
  const probe: ServiceOwnerProbe = { current: () => owner, active: () => "unknown" };
  fs.mkdirSync(path.dirname(serviceDrainFile(paths)), { recursive: true });
  fs.writeFileSync(serviceDrainFile(paths), JSON.stringify(owner));
  assert.throws(() => beginServiceDrain(paths, probe), /cannot be verified/);
  assert.equal(fs.existsSync(serviceDrainFile(paths)), true);
});

test("crashed admission leases recover only with positive stale-owner provenance", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-service-admission-stale-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  const dir = path.join(paths.dir, "service", "admissions");
  const lease = path.join(dir, "crashed-owner");
  const stale = { version: 1 as const, pid: 41, startedAt: "2026-10-14T10:00:00.000Z", owner: "operator" };
  const current = { version: 1 as const, pid: 42, startedAt: "2026-10-14T11:00:00.000Z", owner: "operator" };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(lease, `${JSON.stringify(stale)}\n`);
  const staleProbe: ServiceOwnerProbe = { current: () => current, active: () => false };
  assert.equal(serviceAdmissionsIdle(paths, staleProbe), true);
  assert.equal(fs.existsSync(lease), false);

  fs.writeFileSync(lease, `${JSON.stringify(stale)}\n`);
  const unknownProbe: ServiceOwnerProbe = { current: () => current, active: () => "unknown" };
  assert.throws(() => serviceAdmissionsIdle(paths, unknownProbe), /cannot be verified/);
  assert.equal(fs.existsSync(lease), true);
});

test("Windows lock ownership uses the OS principal when inherited account variables change", { skip: process.platform !== "win32" }, (t) => {
  const domain = process.env.USERDOMAIN;
  const user = process.env.USERNAME;
  t.after(() => {
    if (domain === undefined) delete process.env.USERDOMAIN; else process.env.USERDOMAIN = domain;
    if (user === undefined) delete process.env.USERNAME; else process.env.USERNAME = user;
  });
  const before = defaultServiceOwnerProbe.current();
  process.env.USERDOMAIN = "SYNTHETIC-DOMAIN";
  process.env.USERNAME = "synthetic-user";
  const after = defaultServiceOwnerProbe.current();
  assert.equal(after.owner, before.owner);
  assert.match(after.owner, /^S-\d+(?:-\d+)+$/);
  assert.notEqual(defaultServiceOwnerProbe.active(after), false, "a live owner is never classified as stale from inherited environment drift");
  assert.equal(defaultServiceOwnerProbe.active({ ...after, owner: "EXAMPLE\\legacy-account" }), "unknown",
    "a legacy account-name owner cannot be classified stale against a SID observation");
});

test("concurrent processes serialize stale-owner reclaim", { timeout: 30_000 }, async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-service-reclaim-"));
  const children: ReturnType<typeof spawn>[] = [];
  t.after(() => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const file = path.join(temp, "owner.lock");
  const gate = path.join(temp, "go");
  const releaseGate = path.join(temp, "release");
  const outcomes = [path.join(temp, "outcome-1"), path.join(temp, "outcome-2")];
  const moduleUrl = pathToFileURL(path.resolve("modules/control-plane/node/service-drain.mts")).href;
  const stalePid = 2_000_000_000;
  fs.writeFileSync(file, `${JSON.stringify({ ...defaultServiceOwnerProbe.current(), pid: stalePid, startedAt: "2000-01-01T00:00:00.000Z" })}\n`);
  const program = (outcome: string) => `import fs from "node:fs";import{acquireServiceOwnerFile,defaultServiceOwnerProbe as p}from ${JSON.stringify(moduleUrl)};`
    + `while(!fs.existsSync(${JSON.stringify(gate)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);`
    + `const probe={current:()=>p.current(),active:o=>o.pid===${stalePid}?false:p.active(o)};`
    + `try{const release=acquireServiceOwnerFile(${JSON.stringify(file)},"synthetic active",probe);fs.writeFileSync(${JSON.stringify(outcome)},"owned",{flag:"wx"});console.log("owned");`
    + `while(!fs.existsSync(${JSON.stringify(releaseGate)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);`
    + `release()}catch(error){fs.writeFileSync(${JSON.stringify(outcome)},"blocked",{flag:"wx"});console.log("blocked:"+error.message)}`;
  const run = (outcome: string) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", program(outcome)], { stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let stdout = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    const result = new Promise<string>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", code => code === 0 ? resolve(stdout.trim()) : reject(new Error("synthetic contender failed")));
    });
    return result;
  };
  const bounded = async <T,>(operation: Promise<T>, timeoutMs: number): Promise<T> => {
    let timer!: NodeJS.Timeout;
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("synthetic contenders timed out")), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  };
  const contenders = outcomes.map(run);
  fs.writeFileSync(gate, "go");
  await bounded((async () => {
    while (!outcomes.every(outcome => fs.existsSync(outcome))) await new Promise(resolve => setTimeout(resolve, 10));
  })(), 10_000);
  const observed = outcomes.map(outcome => fs.readFileSync(outcome, "utf8")).sort();
  assert.deepEqual(observed, ["blocked", "owned"], observed.join(" | "));
  fs.writeFileSync(releaseGate, "release");
  const results = (await bounded(Promise.all(contenders), 15_000)).sort();
  assert.equal(results.filter(value => value === "owned").length, 1, results.join(" | "));
  assert.equal(results.filter(value => value.startsWith("blocked:")).length, 1, results.join(" | "));
});

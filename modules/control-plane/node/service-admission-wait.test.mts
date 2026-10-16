import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { nodePaths } from "./config.mts";
import { serviceAdmissionsIdle } from "./service-drain.mts";
import { defaultServiceOwnerProbe } from "./service-owner-probe.mts";
import { lifecycleDefaults, prepareStop, proveStopped, type LifecycleDependencies } from "./service-lifecycle.mts";
import type { ServiceAdapter, ServiceBinding } from "./service-types.mts";

const owner = { version: 1 as const, pid: 4242, startedAt: "2026-10-14T12:00:00+02:00", owner: "RAW-OWNER-CANARY" };
const descriptor = (name: string, pid = owner.pid): string =>
  `lease=${crypto.createHash("sha256").update(name).digest("hex").slice(0, 12)} pid=${pid} processStartedAt=2026-10-14T10:00:00.000Z`;

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-admission-wait-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  const events: string[] = [];
  const messages: string[] = [];
  const unexpected = async (): Promise<never> => { throw new Error("unexpected native adapter operation"); };
  const adapter: ServiceAdapter = {
    platform: "win32", currentUser: unexpected, read: unexpected, fresh: unexpected, freshSecurity: unexpected,
    adoptionNode: unexpected, adoptionSourceRoot: unexpected, adoptionLogFile: unexpected, adopted: unexpected,
    retargeted: unexpected, validateManaged: unexpected, processOwned: unexpected, write: unexpected,
    remove: unexpected, start: unexpected,
    preflightStop: async () => { events.push("preflight"); }, stop: async () => { events.push("stop"); },
  };
  const binding: ServiceBinding = { platform: "win32", serviceName: "synthetic", workspace: root, configRoot: root,
    nodeExecutable: process.execPath, source: { root, commit: "a".repeat(40), digest: "b".repeat(64), kind: "pin", verified: true } };
  t.mock.method(defaultServiceOwnerProbe, "current", () => ({ ...owner, pid: 4343 }));
  const active = t.mock.method(defaultServiceOwnerProbe, "active", () => true);
  let clock = 0;
  let sleeps = 0;
  t.mock.method(Date, "now", () => clock);
  const deps: LifecycleDependencies = { paths, adapter, timeoutMs: 200, reportAdmissionWait: message => messages.push(message),
    sleep: async milliseconds => { clock += milliseconds; sleeps += 1; } };
  const lease = (name: string, pid = owner.pid) => {
    const dir = path.join(paths.dir, "service", "admissions");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, `${JSON.stringify({ ...owner, pid })}\n`, { mode: 0o600 });
    return file;
  };
  return { binding, deps, events, messages, active, lease, sleeps: () => sleeps };
}

test("an active admission reports once across polls and times out before any native preflight or stop", async (t) => {
  const f = fixture(t);
  const name = process.platform === "win32" ? "RAW-FILENAME-CANARY with spaces" : "RAW-FILENAME-CANARY with spaces\ncontrol";
  const file = f.lease(name);
  const bytes = fs.readFileSync(file, "utf8");
  const stdout = t.mock.method(console, "log", () => { throw new Error("admission diagnostics must not use stdout"); });
  await assert.rejects(prepareStop(f.binding, null, f.deps), {
    message: `managed service admission wait timed out; ${descriptor(name)}`,
  });
  assert.deepEqual(f.messages, [`waiting for service admission: ${descriptor(name)}`]);
  assert.equal(f.sleeps(), 3);
  assert.equal(f.active.mock.callCount(), 3);
  assert.deepEqual(f.events, []);
  assert.equal(stdout.mock.callCount(), 0);
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
  assert.doesNotMatch(f.messages.join("\n"), /RAW-|with spaces|control|control-plane|admissions/);
});

test("a changed first blocker is reported and releasing the last lease permits exactly one preflight", async (t) => {
  const f = fixture(t);
  const first = f.lease("a-first");
  const second = f.lease("b-second", 4444);
  let sleeps = 0;
  const advance = f.deps.sleep!;
  f.deps.sleep = async milliseconds => {
    await advance(milliseconds);
    fs.rmSync(sleeps++ === 0 ? first : second);
  };
  await prepareStop(f.binding, null, f.deps);
  assert.deepEqual(f.messages, [
    `waiting for service admission: ${descriptor("a-first")}`,
    `waiting for service admission: ${descriptor("b-second", 4444)}`,
  ]);
  assert.equal(sleeps, 2);
  assert.deepEqual(f.events, ["preflight"]);
});

test("unknown admission ownership throws immediately, retaining bytes without sleep or preflight", async (t) => {
  const f = fixture(t);
  const file = f.lease("unknown");
  const bytes = fs.readFileSync(file, "utf8");
  f.active.mock.mockImplementation(() => "unknown" as const);
  await assert.rejects(prepareStop(f.binding, null, f.deps), { message: "service admission lease owner cannot be verified" });
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
  assert.equal(f.sleeps(), 0);
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.messages, []);
});

test("no admissions need no report or sleep and proceed to preflight", async (t) => {
  const f = fixture(t);
  await prepareStop(f.binding, null, f.deps);
  assert.deepEqual(f.messages, []);
  assert.equal(f.sleeps(), 0);
  assert.deepEqual(f.events, ["preflight"]);
});

test("the production wait reporter uses stderr when no reporter is supplied", async (t) => {
  const f = fixture(t);
  const file = f.lease("stderr");
  delete f.deps.reportAdmissionWait;
  const stderr = t.mock.method(console, "error", (message: string) => f.messages.push(message));
  f.deps.sleep = async () => { fs.rmSync(file); };
  await prepareStop(f.binding, null, f.deps);
  assert.equal(stderr.mock.callCount(), 1);
  assert.deepEqual(f.messages, [`waiting for service admission: ${descriptor("stderr")}`]);
  assert.deepEqual(f.events, ["preflight"]);
});

test("other lifecycle polling retains the default verification timeout", async (t) => {
  const f = fixture(t);
  await assert.rejects(proveStopped(4242, lifecycleDefaults({ ...f.deps, pidAlive: () => true })), {
    message: "managed service verification timed out",
  });
  assert.equal(f.sleeps(), 3);
  assert.deepEqual(f.messages, []);
  assert.deepEqual(f.events, []);
});

for (const exactCurrent of [true, false]) {
  for (const code of [undefined, "ENOENT"]) {
    test(`${exactCurrent ? "current" : "probed"} active admission stays blocked when its diagnostic throws ${code ?? "Error"}`, (t) => {
      const f = fixture(t);
      const file = f.lease("throwing-diagnostic");
      const bytes = fs.readFileSync(file, "utf8");
      let observations = 0;
      const probe = { current: () => ({ ...owner, pid: exactCurrent ? owner.pid : 4343 }), active: () => {
        observations += 1; return true;
      } };
      const result = serviceAdmissionsIdle(f.deps.paths, probe, () => {
        throw Object.assign(new Error("RAW-DIAGNOSTIC-CANARY"), code ? { code } : {});
      });
      assert.equal(result, false);
      assert.equal(observations, exactCurrent ? 0 : 1);
      assert.equal(fs.readFileSync(file, "utf8"), bytes);
    });
  }
}

test("a failed wait reporter is attempted once while admission still times out safely", async (t) => {
  const f = fixture(t);
  const file = f.lease("failed-reporter");
  const bytes = fs.readFileSync(file, "utf8");
  let reports = 0;
  f.deps.reportAdmissionWait = () => {
    reports += 1;
    throw Object.assign(new Error("RAW-REPORTER-CANARY"), { code: "ENOENT" });
  };
  await assert.rejects(prepareStop(f.binding, null, f.deps), {
    message: `managed service admission wait timed out; ${descriptor("failed-reporter")}`,
  });
  assert.equal(reports, 1);
  assert.equal(f.sleeps(), 3);
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
  assert.deepEqual(f.messages, []);
  assert.deepEqual(f.events, []);
});

test("releasing admission permits one preflight despite a failed wait reporter", async (t) => {
  const f = fixture(t);
  const file = f.lease("released-after-report-failure");
  let reports = 0;
  f.deps.reportAdmissionWait = () => {
    reports += 1;
    throw Object.assign(new Error("RAW-REPORTER-CANARY"), { code: "ENOENT" });
  };
  const advance = f.deps.sleep!;
  f.deps.sleep = async milliseconds => { await advance(milliseconds); fs.rmSync(file); };
  await prepareStop(f.binding, null, f.deps);
  assert.equal(reports, 1);
  assert.equal(f.sleeps(), 1);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(f.events, ["preflight"]);
});

test("failed optional descriptor construction cannot make admission idle or print undefined", async (t) => {
  const f = fixture(t);
  const file = f.lease("failed-descriptor");
  const bytes = fs.readFileSync(file, "utf8");
  t.mock.method(crypto, "createHash", () => { throw Object.assign(new Error("RAW-HASH-CANARY"), { code: "ENOENT" }); });
  await assert.rejects(prepareStop(f.binding, null, f.deps), { message: "managed service admission wait timed out" });
  assert.equal(f.sleeps(), 3);
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
  assert.deepEqual(f.messages, []);
  assert.deepEqual(f.events, []);
});

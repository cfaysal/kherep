import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { nodePaths } from "./config.mts";
import {
  beginServiceDrain, continueServiceAdmission, retainServiceAdmission, serviceAdmissionsIdle, withServiceAdmission,
  type ServiceAdmission, type ServiceOwnerProbe,
} from "./service-drain.mts";

const owner = { version: 1 as const, pid: 4242, startedAt: "2026-01-01T00:00:00.000Z", owner: "synthetic" };
const testServiceOwner: ServiceOwnerProbe = { current: () => owner, active: () => true };
const deferred = () => {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { await new Promise<void>(resolve => setImmediate(resolve)); };
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-retained-admission-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  const dir = path.join(paths.dir, "service", "admissions");
  return { paths, lease: () => path.join(dir, fs.readdirSync(dir)[0]!), idle: () => serviceAdmissionsIdle(paths, testServiceOwner) };
}

test("a finished admission releases only after its helper is positively stopped", async t => {
  const f = fixture(t), stopped = deferred();
  let token!: ServiceAdmission;
  await withServiceAdmission(f.paths, async admission => {
    token = admission; retainServiceAdmission(admission, stopped.promise);
  }, testServiceOwner);
  assert.equal(f.idle(), false);
  stopped.resolve(); await flush();
  assert.equal(f.idle(), true);
  assert.throws(() => retainServiceAdmission(token, stopped.promise), /not active/);
  const endDrain = beginServiceDrain(f.paths, testServiceOwner);
  await assert.rejects(continueServiceAdmission(f.paths, token, async () => assert.fail("finished token reused")), /draining/);
  endDrain();
});

test("helper completion before operation completion cannot release the lease", async t => {
  const f = fixture(t), stopped = deferred(), operation = deferred(), entered = deferred();
  const pending = withServiceAdmission(f.paths, async admission => {
    retainServiceAdmission(admission, stopped.promise); entered.resolve(); await operation.promise;
  }, testServiceOwner);
  await entered.promise; stopped.resolve(); await flush();
  assert.equal(f.idle(), false);
  operation.resolve(); await pending;
  assert.equal(f.idle(), true);
});

test("each distinct helper holds the admission and duplicate evidence is idempotent", async t => {
  const f = fixture(t), first = deferred(), second = deferred();
  await withServiceAdmission(f.paths, async admission => {
    retainServiceAdmission(admission, first.promise); retainServiceAdmission(admission, first.promise);
    retainServiceAdmission(admission, second.promise);
  }, testServiceOwner);
  first.resolve(); await flush(); assert.equal(f.idle(), false);
  second.resolve(); await flush(); assert.equal(f.idle(), true);
  first.resolve(); second.resolve(); await flush(); assert.equal(f.idle(), true);
});

for (const kind of ["rejected", "permanent", "unknown"] as const) {
  test(`${kind} evidence keeps the finished admission blocked`, async t => {
    const f = fixture(t), stopped = deferred(), other = deferred();
    await withServiceAdmission(f.paths, async admission => {
      retainServiceAdmission(admission, stopped.promise);
      if (kind === "permanent") retainServiceAdmission(admission);
      else retainServiceAdmission(admission, other.promise);
    }, testServiceOwner);
    stopped.resolve();
    if (kind === "rejected") other.reject(new Error("synthetic observation failure"));
    await flush(); assert.equal(f.idle(), false);
  });
}

test("an operation failure preserves its error and still allows later positive release", async t => {
  const f = fixture(t), stopped = deferred(), failure = new Error("synthetic operation failure");
  await assert.rejects(withServiceAdmission(f.paths, async admission => {
    retainServiceAdmission(admission, stopped.promise); throw failure;
  }, testServiceOwner), error => error === failure);
  assert.equal(f.idle(), false);
  stopped.resolve(); await flush(); assert.equal(f.idle(), true);
});

test("late release preserves replaced lease bytes and tolerates an already absent lease", async t => {
  for (const replaced of [true, false]) {
    const f = fixture(t), stopped = deferred();
    await withServiceAdmission(f.paths, async admission => retainServiceAdmission(admission, stopped.promise), testServiceOwner);
    const lease = f.lease(), bytes = `${JSON.stringify({ ...owner, pid: 4343 })}\n`;
    if (replaced) fs.writeFileSync(lease, bytes); else fs.rmSync(lease);
    stopped.resolve(); await flush();
    if (replaced) { assert.equal(fs.readFileSync(lease, "utf8"), bytes); assert.equal(f.idle(), false); }
    else assert.equal(f.idle(), true);
  }
});

test("late cleanup failure is handled and leaves the disk blocker", async t => {
  const f = fixture(t), stopped = deferred();
  await withServiceAdmission(f.paths, async admission => retainServiceAdmission(admission, stopped.promise), testServiceOwner);
  const lease = f.lease(), remove = fs.rmSync;
  const mocked = t.mock.method(fs, "rmSync", ((file: fs.PathLike, ...args: unknown[]) => {
    if (file === lease) throw Object.assign(new Error("synthetic denied"), { code: "EACCES" });
    return Reflect.apply(remove, fs, [file, ...args]);
  }) as typeof fs.rmSync);
  try { stopped.resolve(); await flush(); assert.equal(f.idle(), false); }
  finally { mocked.mock.restore(); }
});

test("ordinary synchronous cleanup failures still reject the operation", async t => {
  const f = fixture(t), failure = new Error("synthetic cleanup failure"), remove = fs.rmSync;
  const mocked = t.mock.method(fs, "rmSync", ((file: fs.PathLike, ...args: unknown[]) => {
    if (String(file).includes(`${path.sep}admissions${path.sep}`)) throw failure;
    return Reflect.apply(remove, fs, [file, ...args]);
  }) as typeof fs.rmSync);
  try { await assert.rejects(withServiceAdmission(f.paths, async () => {}, testServiceOwner), error => error === failure); }
  finally { mocked.mock.restore(); }
});

test("forged admission tokens cannot register evidence", () => {
  assert.throws(() => retainServiceAdmission({ root: "/synthetic" }, Promise.resolve()), /not active/);
});

test("unrelated positive proof cannot release a disk-only lease of the same live owner", async t => {
  const f = fixture(t), stopped = deferred();
  const dir = path.join(f.paths.dir, "service", "admissions");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const legacy = path.join(dir, "synthetic-legacy-lease"), bytes = `${JSON.stringify(owner)}\n`;
  fs.writeFileSync(legacy, bytes, { mode: 0o600, flag: "wx" });
  await withServiceAdmission(f.paths, async admission => retainServiceAdmission(admission, stopped.promise), testServiceOwner);
  const own = fs.readdirSync(dir).filter(name => name !== path.basename(legacy));
  assert.equal(own.length, 1);
  assert.equal(f.idle(), false);
  stopped.resolve(); await flush();
  assert.equal(fs.existsSync(path.join(dir, own[0]!)), false, "proof releases only its creating admission");
  for (let check = 0; check < 2; check++) {
    assert.equal(f.idle(), false, "legacy helper state remains unknown while its owner is alive");
    assert.equal(fs.readFileSync(legacy, "utf8"), bytes);
    assert.deepEqual(fs.readdirSync(dir), [path.basename(legacy)]);
  }
});

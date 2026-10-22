import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import type { InboxRecord } from "./inbox.mts";
import { RecordLockBusy, recordLockFile } from "./inbox-record-lock.mts";
import { handoverTaskMessages } from "./task-handover.mts";
import { handoverInbox, id, scope, FOREIGN, FROM, TO, MID } from "./task-handover-fixture.mts";

type Fixture = ReturnType<typeof handoverInbox>;
function atLock(t: test.TestContext, f: Fixture, acquisition: number, mutate: () => void) {
  const open = fs.openSync; let count = 0;
  t.mock.method(fs, "openSync", (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    if (file === recordLockFile(f.dir, id(20)) && flags === "wx" && ++count === acquisition) mutate();
    return open(file, flags, mode);
  });
}
function replace(f: Fixture, record: InboxRecord) { fs.writeFileSync(f.file(record.messageId), JSON.stringify(record)); }

const addressRaces: { name: string; initial?: Partial<InboxRecord>; next: (r: InboxRecord) => InboxRecord | null; moved: boolean }[] = [
  { name: "disappearance", next: () => null, moved: false },
  { name: "delivered", next: (r) => ({ ...r, state: "delivered" }), moved: false },
  { name: "refused", next: (r) => ({ ...r, state: "refused" }), moved: false },
  { name: "terminal concurrently at target", next: (r) => ({ ...r, toSession: TO, state: "delivered" }), moved: false },
  { name: "foreign at source retains legacy movement", next: (r) => ({ ...r, delivery: { ...r.delivery!, taskId: FOREIGN } }), moved: true },
  { name: "foreign intermediate", initial: { toSession: MID }, next: (r) => ({ ...r, delivery: { ...r.delivery!, taskId: FOREIGN } }), moved: false },
  { name: "wrong runtime intermediate", initial: { toSession: MID }, next: (r) => ({ ...r, delivery: { ...r.delivery!, runtime: "codex" } }), moved: false },
  { name: "unowned source moved away", initial: { delivery: undefined }, next: (r) => ({ ...r, toSession: MID }), moved: false },
  { name: "owned new intermediate and fresh provenance", initial: { closedTo: undefined }, next: (r) => ({ ...r, toSession: "another-intermediate", retry: true }), moved: true },
];
for (const row of addressRaces) test(`address acquisition rechecks ${row.name}`, (t) => {
  const f = handoverInbox(t), before = f.store(20, row.initial), fresh = row.next(before);
  atLock(t, f, 1, () => { if (fresh) replace(f, fresh); else fs.unlinkSync(f.file(id(20))); });
  const writes = f.observeWrites(); handoverTaskMessages(f.dir, FROM, TO, scope);
  if (!fresh) { assert.equal(fs.existsSync(f.file(id(20))), false); assert.deepEqual(writes, []); return; }
  const owned = fresh.delivery?.taskId === scope.taskId && fresh.delivery.runtime === scope.runtime;
  assert.deepEqual(f.get(id(20)), JSON.parse(JSON.stringify({ ...fresh,
    ...(row.moved ? { toSession: TO, closedTo: fresh.closedTo ?? fresh.toSession } : {}),
    ...((row.moved || fresh.toSession === TO) && owned ? { delivery: { ...fresh.delivery!, sessionId: TO } } : {}) })));
  if (!row.moved && fresh.toSession !== TO) assert.deepEqual(writes, []);
});

for (const change of ["task", "runtime", "address", "disappear", "terminal-target", "terminal-away"] as const) {
  test(`identity acquisition rechecks ${change}`, (t) => {
    const f = handoverInbox(t); f.store(20, { toSession: TO });
    let fresh: InboxRecord | null = null;
    atLock(t, f, 1, () => {
      const record = f.get(id(20));
      fresh = change === "disappear" ? null : { ...record,
        ...(change === "task" ? { delivery: { ...record.delivery!, taskId: FOREIGN } } : {}),
        ...(change === "runtime" ? { delivery: { ...record.delivery!, runtime: "codex" as const } } : {}),
        ...(change === "address" || change === "terminal-away" ? { toSession: MID } : {}),
        ...(change.startsWith("terminal") ? { state: "delivered" as const } : {}) };
      if (fresh) replace(f, fresh); else fs.unlinkSync(f.file(id(20)));
    });
    const writes = f.observeWrites(); handoverTaskMessages(f.dir, FROM, TO, scope);
    if (change === "terminal-target") {
      assert.deepEqual(f.get(id(20)), { ...(fresh as unknown as InboxRecord), delivery: { ...scope, sessionId: TO } });
      assert.equal(writes.length, 1);
    } else { assert.deepEqual(writes, []); if (fresh) assert.deepEqual(f.get(id(20)), fresh); }
  });
}

for (const phase of ["address", "identity"] as const) test(`typed busy in ${phase} propagates and retry converges`, (t) => {
  const f = handoverInbox(t); f.store(20); f.store(21);
  if (phase === "address") f.hold(id(21));
  else {
    const open = fs.openSync; let count = 0;
    t.mock.method(fs, "openSync", (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (file === recordLockFile(f.dir, id(21)) && flags === "wx" && ++count === 2) f.hold(id(21));
      return open(file, flags, mode);
    });
  }
  assert.throws(() => handoverTaskMessages(f.dir, FROM, TO, scope), (e) => e instanceof RecordLockBusy && e.messageId === id(21));
  assert.equal(f.get(id(20)).toSession, TO);
  assert.equal(f.get(id(20)).delivery?.sessionId, phase === "address" ? FROM : TO);
  assert.equal(f.get(id(21)).toSession, phase === "address" ? FROM : TO);
  fs.unlinkSync(recordLockFile(f.dir, id(21))); handoverTaskMessages(f.dir, FROM, TO, scope);
  for (const n of [20, 21]) assert.deepEqual([f.get(id(n)).toSession, f.get(id(n)).delivery?.sessionId], [TO, TO]);
});

test("nonbusy IO errors propagate unchanged without mutation", (t) => {
  const f = handoverInbox(t); f.store(20); const before = f.bytes(id(20)), open = fs.openSync;
  const error = Object.assign(new Error("synthetic EIO"), { code: "EIO" });
  t.mock.method(fs, "openSync", (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    if (file === recordLockFile(f.dir, id(20)) && flags === "wx") throw error;
    return open(file, flags, mode);
  });
  assert.throws(() => handoverTaskMessages(f.dir, FROM, TO, scope), (e) => e === error);
  assert.equal(f.bytes(id(20)), before);
});

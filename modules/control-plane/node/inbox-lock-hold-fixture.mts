// Synthetic two-process storage fixture, never part of an installed Hook.
// Holds the record lock of <dir>/<messageId> the way a writer does (issue
// #627), prints "locked", waits holdMs, writes the record's state while still
// holding the lock, releases it and exits. The lock is created by hand, not
// through inbox-record-lock.mts, so the same fixture runs against a checkout
// without that module.
import fs from "node:fs";
import path from "node:path";

import { getMessage, writeJsonAtomic, type InboxRecord } from "./inbox.mts";

const [dir, messageId, holdMs, state] = process.argv.slice(2);
const lock = path.join(dir, `.${messageId}.json.lock`);
const handle = fs.openSync(lock, "wx", 0o600);
fs.writeFileSync(handle, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
fs.closeSync(handle);
process.stdout.write("locked\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));
const record = getMessage(dir, messageId);
if (!record) throw new Error("the record vanished while the fixture held its lock");
writeJsonAtomic(path.join(dir, `${messageId}.json`), { ...record, state: state as InboxRecord["state"] });
fs.unlinkSync(lock);

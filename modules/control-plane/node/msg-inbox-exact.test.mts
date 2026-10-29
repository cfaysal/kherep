import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { recordLockFile, RECORD_LOCK_WAIT_MS, setRecordLockWait } from "./inbox-record-lock.mts";
import { nodePaths } from "./config.mts";
import { parseMsgArgs, runMsg } from "./msg-cli.mts";

const OWNER = "019a0000-0000-7000-8000-000000000001";
const PEER = "019a0000-0000-7000-8000-000000000002";
const SESSION = "019a0000-0000-7000-8000-000000000003";
const ROOT = "019a0000-0000-7000-8000-000000000004";
const REPLY = "019a0000-0000-7000-8000-000000000005";
const OTHER = "019a0000-0000-7000-8000-000000000006";
const TEXT = "synthetic safe reply";
const HASH = crypto.createHash("sha256").update(TEXT).digest("hex");

export function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-exact-inbox-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = nodePaths(root);
  fs.mkdirSync(paths.inbox, { recursive: true });
  fs.mkdirSync(paths.sent, { recursive: true });
  const file = path.join(paths.inbox, `${REPLY}.json`);
  const sentFile = path.join(paths.sent, `${ROOT}.json`);
  const record = { messageId: REPLY, from: { nodeId: PEER, session: SESSION }, toSession: OWNER,
    inReplyTo: ROOT, text: TEXT, state: "accepted", createdAt: new Date(0).toISOString(), receivedAt: new Date(1).toISOString() };
  const sent = { messageId: ROOT, fromSession: OWNER, fromSessionId: OWNER, to: { nodeId: PEER, session: SESSION },
    text: "synthetic safe request", state: "replied", updatedAt: new Date(2).toISOString() };
  fs.writeFileSync(file, JSON.stringify(record));
  fs.writeFileSync(sentFile, JSON.stringify(sent));
  fs.writeFileSync(path.join(paths.inbox, `${OTHER}.json`), "POISON unrelated body");
  const argv = ["inbox", "--message-id", REPLY, "--from", OWNER, "--expect-node", PEER,
    "--expect-session", SESSION, "--expect-target-session", SESSION, "--expect-reply-to", ROOT, "--expect-text-sha256", HASH];
  return { paths, file, sentFile, record, sent, argv };
}

async function inspect(t: test.TestContext, f: ReturnType<typeof fixture>, argv = f.argv, env: NodeJS.ProcessEnv = { CODEX_THREAD_ID: OWNER }) {
  const out: string[] = [], err: string[] = [], bodyReads = new Set<string>(), violations: string[] = [];
  const handles = new Map<number, string>();
  const originalOpen = fs.openSync, originalRead = fs.readFileSync, originalReadSync = fs.readSync, originalList = fs.readdirSync;
  const check = (value: unknown, reading: boolean) => {
    const name = typeof value === "number" ? handles.get(value) : typeof value === "string" ? value : undefined;
    if (name?.startsWith(f.paths.sent + path.sep) && name !== f.sentFile) {
      violations.push(name); throw new Error("unrelated sent access");
    }
    if (!name || !name.startsWith(f.paths.inbox + path.sep)) return;
    if (name === f.file) { if (reading) bodyReads.add(name); return; }
    if (path.basename(name).startsWith(`.${REPLY}.json.lock`)) return;
    violations.push(name); throw new Error("unrelated incoming access");
  };
  t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    check(args[0], false); const fd = originalOpen(...args); handles.set(fd, String(args[0])); return fd;
  });
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => { check(args[0], true); return originalRead(...args); });
  t.mock.method(fs, "readSync", (...args: Parameters<typeof fs.readSync>) => { check(args[0], true); return originalReadSync(...args); });
  t.mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
    if (String(args[0]) === f.paths.inbox || String(args[0]) === f.paths.sent) {
      violations.push(String(args[0])); throw new Error("incoming or sent enumeration");
    }
    return originalList(...args);
  });
  try {
    const code = await runMsg(argv, { paths: f.paths, env, out: l => out.push(l), err: l => err.push(l) });
    return { code, out: out.join("\n"), err: err.join("\n"), reads: bodyReads.size };
  } finally {
    t.mock.restoreAll(); assert.deepEqual(violations, [], "no unrelated body access or inbox/sent enumeration");
  }
}

test("exact inbox inspection reads only the selected reply and preserves its bytes", async (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.file);
  const result = await inspect(t, f);
  assert.equal(result.code, 0, result.err);
  assert.equal(result.reads, 1);
  assert.deepEqual(JSON.parse(result.out), { messageId: REPLY, from: f.record.from, toSession: OWNER,
    inReplyTo: ROOT, text: TEXT, state: "accepted", createdAt: f.record.createdAt, receivedAt: f.record.receivedAt });
  assert.deepEqual(fs.readFileSync(f.file), before);
});

const selectors = ["--message-id", "--from", "--expect-node", "--expect-session", "--expect-target-session", "--expect-reply-to", "--expect-text-sha256"];
for (const flag of selectors) for (const mode of ["missing", "malformed"]) {
  test(`${mode} ${flag} fails before incoming reads`, async t => {
    const f = fixture(t), argv = [...f.argv], i = argv.indexOf(flag);
    if (mode === "missing") argv.splice(i, 2); else argv[i + 1] = flag === "--expect-session" ? "unsafe\nref" : "unsafe/path";
    const result = await inspect(t, f, argv);
    assert.deepEqual(result, { code: 1, out: "", err: "kherep-node msg: exact-inbox-invalid-selectors", reads: 0 });
  });
}
for (const mix of [["--all"], ["--receive"], ["--wait", "1"], ["--new", "codex"], ["--to", "other"],
  ["--reply-to", ROOT], ["--cwd", "/work"], ["--directive", "x"], ["--expected-run-version", "x"], ["extra"]]) {
  test(`mixed exact mode ${mix[0]} reads nothing`, async t => {
    const f = fixture(t), result = await inspect(t, f, [...f.argv, ...mix]);
    assert.equal(result.code, 1); assert.equal(result.reads, 0); assert.equal(result.out, "");
    assert.equal(result.err, "kherep-node msg: exact-inbox-invalid-selectors");
  });
}
for (const mutation of [{ fromSessionId: OTHER }, { to: { nodeId: OTHER, session: SESSION } },
  { to: { nodeId: PEER, session: "short-alias" } }, { messageId: OTHER }, { inReplyTo: "malformed" }]) {
  test(`wrong authored root ${JSON.stringify(mutation)} reads no incoming body`, async t => {
    const f = fixture(t); fs.writeFileSync(f.sentFile, JSON.stringify({ ...f.sent, ...mutation }));
    const result = await inspect(t, f);
    assert.equal(result.err, "kherep-node msg: exact-inbox-root-mismatch"); assert.equal(result.reads, 0); assert.equal(result.out, "");
  });
}
for (const mutation of [{ messageId: OTHER }, { toSession: OTHER }, { from: { nodeId: OTHER, session: SESSION } },
  { from: { nodeId: PEER, session: OTHER } }, { inReplyTo: OTHER }, { proxyOf: ROOT }, { closedTo: OWNER }, { text: "different" }]) {
  test(`selected mismatch ${JSON.stringify(mutation)} returns only fixed failure`, async t => {
    const f = fixture(t); fs.writeFileSync(f.file, JSON.stringify({ ...f.record, ...mutation }));
    const result = await inspect(t, f);
    assert.equal(result.code, 1); assert.equal(result.out, ""); assert.equal(result.reads, 1);
    assert.equal(result.err, "kherep-node msg: exact-inbox-mismatch");
  });
}

for (const [name, expected] of [["missing", "missing"], ["json", "malformed"], ["schema", "malformed"],
  ["oversized", "oversized"], ["directory", "not-regular"], ["symlink", "not-regular"], ["hardlink", "not-regular"]]) {
  test(`selected ${name} file returns distinct opaque error`, async t => {
    const f = fixture(t);
    if (name === "missing") fs.unlinkSync(f.file);
    if (name === "json") fs.writeFileSync(f.file, "{private malformed body");
    if (name === "schema") fs.writeFileSync(f.file, JSON.stringify({ ...f.record, createdAt: "private content" }));
    if (name === "oversized") fs.writeFileSync(f.file, "x".repeat(128 * 1024 + 1));
    if (["directory", "symlink", "hardlink"].includes(name)) {
      fs.unlinkSync(f.file);
      if (name === "directory") fs.mkdirSync(f.file);
      else {
        try {
          if (name === "symlink") fs.symlinkSync(path.join(f.paths.inbox, `${OTHER}.json`), f.file);
          else fs.linkSync(path.join(f.paths.inbox, `${OTHER}.json`), f.file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("link permission unavailable"); return; }
          throw error;
        }
      }
    }
    const result = await inspect(t, f);
    assert.equal(result.code, 1); assert.equal(result.out, "");
    assert.equal(result.err, `kherep-node msg: exact-inbox-${expected}`);
    assert.equal(result.reads, ["json", "schema"].includes(name) ? 1 : 0);
  });
}

test("unreadable selected file exposes no raw error or text", async t => {
  const f = fixture(t), original = fs.openSync;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    if (args[0] === f.file) throw Object.assign(new Error("private path and body"), { code: "EACCES" });
    return original(...args);
  });
  const result = await inspect(t, f);
  assert.deepEqual(result, { code: 1, out: "", err: "kherep-node msg: exact-inbox-unreadable", reads: 0 });
});

test("busy selected lock reads no incoming body", async t => {
  const f = fixture(t);
  fs.writeFileSync(recordLockFile(f.paths.inbox, REPLY), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  setRecordLockWait(0);
  try {
    const result = await inspect(t, f);
    assert.deepEqual(result, { code: 1, out: "", err: "kherep-node msg: exact-inbox-locked", reads: 0 });
  } finally { setRecordLockWait(RECORD_LOCK_WAIT_MS); }
});

for (const mode of ["replace", "grow"]) test(`concurrent ${mode} is refused with bounded reads`, async t => {
  const f = fixture(t), original = fs.readSync;
  let changed = false, totalBytes = 0, selectedFd = -1;
  const originalOpen = fs.openSync;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    const fd = originalOpen(...args); if (args[0] === f.file) selectedFd = fd; return fd;
  });
  t.mock.method(fs, "readSync", (...args: Parameters<typeof fs.readSync>) => {
    const count = original(...args); totalBytes += count;
    if (!changed && args[0] === selectedFd) {
      changed = true;
      if (mode === "replace") { fs.unlinkSync(f.file); fs.writeFileSync(f.file, JSON.stringify(f.record)); }
      else fs.appendFileSync(f.file, "x".repeat(128 * 1024));
    }
    return count;
  });
  const result = await inspect(t, f);
  assert.equal(result.code, 1); assert.equal(result.out, "");
  assert.equal(result.err, `kherep-node msg: exact-inbox-${mode === "grow" ? "oversized" : "changed"}`);
  assert.ok(totalBytes <= 2 * (128 * 1024 + 1), "each selected root and reply read is bounded");
});

test("unverified caller reads no incoming record", async t => {
  const f = fixture(t), result = await inspect(t, f, f.argv, {});
  assert.deepEqual(result, { code: 1, out: "", err: "kherep-node msg: exact-inbox-identity-unverified", reads: 0 });
});

for (const command of ["send", "status", "sessions", "stop"]) test(`exact flags cannot enter ${command}`, async t => {
  const f = fixture(t), result = await inspect(t, f, [command, ...f.argv.slice(1)]);
  assert.deepEqual(result, { code: 1, out: "", err: "kherep-node msg: exact-inbox-invalid-selectors", reads: 0 });
});

test("maximal escaped text stays bounded and excludes arbitrary record fields", async t => {
  const f = fixture(t), text = "\u0000".repeat(16384);
  fs.writeFileSync(f.file, JSON.stringify({ ...f.record, text, reason: "unclassified extra field" }));
  const argv = [...f.argv]; argv[argv.indexOf("--expect-text-sha256") + 1] = crypto.createHash("sha256").update(text).digest("hex");
  const result = await inspect(t, f, argv);
  assert.equal(result.code, 0, result.err); assert.equal(JSON.parse(result.out).text, text);
  assert.ok(Buffer.byteLength(result.out) < 128 * 1024); assert.ok(!result.out.includes("unclassified"));
});

for (const suffix of [["--message-id"], ["--from", OWNER], ["--expect-node", PEER], ["--unexpected"]]) {
  test(`invalid exact option syntax ${suffix.join(" ")} is opaque`, async t => {
    const f = fixture(t), result = await inspect(t, f, [...f.argv, ...suffix]);
    assert.deepEqual(result, { code: 1, out: "", err: "kherep-node msg: exact-inbox-invalid-selectors", reads: 0 });
  });
}
for (const bytes of [null, "{bad", "x".repeat(128 * 1024 + 1)]) test("unavailable selected root blocks incoming reads", async t => {
  const f = fixture(t);
  if (bytes === null) fs.unlinkSync(f.sentFile); else fs.writeFileSync(f.sentFile, bytes);
  const result = await inspect(t, f);
  assert.deepEqual(result, { code: 1, out: "", err: "kherep-node msg: exact-inbox-root-unavailable", reads: 0 });
});

test("an ordinary threaded sent parent is inspected without following its ancestor", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.sentFile, JSON.stringify({ ...f.sent, inReplyTo: OTHER }));
  fs.writeFileSync(path.join(f.paths.sent, `${OTHER}.json`), "POISON unrelated sent ancestor");
  const result = await inspect(t, f);
  assert.equal(result.code, 0, result.err);
  assert.equal(result.reads, 1); assert.equal(JSON.parse(result.out).inReplyTo, ROOT);
});

test("exact selector spellings after option terminator never enter broad inbox", async t => {
  const f = fixture(t), result = await inspect(t, f, ["inbox", "--", ...f.argv.slice(1)]);
  assert.deepEqual(result, { code: 1, out: "", err: "kherep-node msg: exact-inbox-invalid-selectors", reads: 0 });
});

test("named raw sender and explicit full target bind independently without alias resolution", async t => {
  const f = fixture(t), argv = [...f.argv], raw = "peer-review";
  fs.writeFileSync(f.file, JSON.stringify({ ...f.record, from: { nodeId: PEER, session: raw } }));
  argv[argv.indexOf("--expect-session") + 1] = raw;
  const result = await inspect(t, f, argv);
  assert.equal(result.code, 0, result.err);
  assert.equal(result.reads, 1); assert.equal(JSON.parse(result.out).from.session, raw);
});

test("send retains selector spellings as literal text after option terminator", () => {
  const args = ["send", "peer/session", "--", "--message-id", "literal", "--expect-target-session=literal"];
  const parsed = parseMsgArgs(args);
  assert.deepEqual(parsed.positionals, ["send", "peer/session", "--message-id", "literal", "--expect-target-session=literal"]);
  assert.deepEqual({ ...parsed.values }, {});
});

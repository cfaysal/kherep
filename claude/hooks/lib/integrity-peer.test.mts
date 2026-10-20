#!/usr/bin/env node
// Unit test for the peers record of integrity-heartbeat.mts (issue #507, part 4,
// amendment B1). The Codex integrity run records each dispatcher file from an
// fd-bound snapshot of exactly the bytes it judged: open, fstat(fd) as bigint,
// read from that fd, close, the syntax verdict on those bytes, then a re-stat of
// the path plus its real path. A tuple is recorded only when the verdict is OK
// and the path still names the bytes judged. Deterministic seams stand in for a
// concurrent writer (no timing). Runs in the Windows hooks shard too.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import * as heartbeat from "./integrity-heartbeat.mts";
import { syntaxVerdict } from "./hook-syntax.mts";

// Through the namespace, so a lib without the function fails each case on its own.
type Tuple = { dev: string; ino: string; size: string; mtimeNs: string; sha256: string };
type Seams = { beforeRead?: () => void; beforeVerdict?: () => void; beforeRestat?: () => void };
const provenPeer = (file: string, seams?: Seams): Promise<Tuple | null> =>
  (heartbeat as unknown as { provenPeer: (f: string, j: typeof syntaxVerdict, s?: Seams) => Promise<Tuple | null> }).provenPeer(file, syntaxVerdict, seams);

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "integrity-peer-")));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
let seq = 0;
const A = "export const broken = ;\n"; // defective
const B = "export const healthy = 1;\n";
// A dispatcher path P holding `text`, and the names the swaps use.
function box(text: string): { p: string; aside: string; spare: string; dir: string } {
  const dir = path.join(TMP, `case-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "codex-shell-checks.mts");
  fs.writeFileSync(p, text);
  return { p, aside: path.join(dir, "aside.mts"), spare: path.join(dir, "spare.mts"), dir };
}
// The dispatchers' gate (hook-adapter.mts, shell-checks.mts): a current bigint stat against the record.
function gate(file: string, record: Tuple | null | undefined): string {
  if (!record) return "no proven record";
  const s = fs.statSync(file, { bigint: true });
  for (const [key, label] of [["ino", "inode"], ["dev", "device"], ["size", "size"], ["mtimeNs", "mtime"]] as const) {
    if (record[key] !== String(s[key])) return `${label} changed`;
  }
  return "";
}

test("T14c writeHeartbeat serializes peers; without them the bytes keep the part 3 form", () => {
  const home = path.join(TMP, `case-${++seq}`, ".codex");
  const peers = { "codex-shell-checks.mts": { dev: "1", ino: "2", size: "3", mtimeNs: "4", sha256: "ab" } };
  assert.equal(heartbeat.writeHeartbeat(home, { trigger: "hook-adapter", runtime: "codex", files: 3, peers } as Parameters<typeof heartbeat.writeHeartbeat>[1]), "");
  const beat = JSON.parse(fs.readFileSync(heartbeat.heartbeatFile(home), "utf8"));
  assert.deepEqual(beat.peers, peers);
  assert.equal(heartbeat.writeHeartbeat(home, { trigger: "session-start", runtime: "claude", files: 3 }), "");
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(heartbeat.heartbeatFile(home), "utf8"))), ["ts", "trigger", "runtime", "files", "pid"]);
});

test("T15a ABA, A put back after the parse: the gate on the current A reports a mismatch or a missing record", async () => {
  // a1: the path names A when it is opened; B is swapped in before the read. The fd still reads A: DEFEKT, no record.
  const one = box(A);
  fs.writeFileSync(one.spare, B);
  const a1 = await provenPeer(one.p, { beforeRead: () => { fs.renameSync(one.p, one.aside); fs.renameSync(one.spare, one.p); } });
  fs.renameSync(one.p, one.spare);
  fs.renameSync(one.aside, one.p); // A back
  assert.equal(a1, null);
  assert.equal(gate(one.p, a1), "no proven record");
  // a2: B is in place when the file is opened, so the record is B's; A comes back afterwards by rename.
  const two = box(A);
  fs.writeFileSync(two.spare, B);
  fs.renameSync(two.p, two.aside);
  fs.renameSync(two.spare, two.p);
  const a2 = await provenPeer(two.p);
  assert.ok(a2, "B is healthy and unchanged while judged");
  fs.renameSync(two.p, two.spare);
  fs.renameSync(two.aside, two.p); // A back
  assert.equal(gate(two.p, a2), "inode changed");
});

test("T15b ABA, A put back before the parser: no tuple, so the next dispatcher call treats the peer as broken", async () => {
  const b = box(A);
  fs.writeFileSync(b.spare, B);
  fs.renameSync(b.p, b.aside);
  fs.renameSync(b.spare, b.p);
  let judged = "";
  const tuple = await provenPeer(b.p, { beforeVerdict: () => { fs.renameSync(b.p, b.spare); fs.renameSync(b.aside, b.p); } });
  judged = fs.readFileSync(b.p, "utf8");
  assert.equal(judged, A, "A is back at the path");
  assert.equal(tuple, null, "the verdict was on B's bytes, the path names A: not recorded");
  assert.equal(gate(b.p, tuple), "no proven record");
  // The same with the swap between the verdict and the re-stat.
  const c = box(B);
  fs.writeFileSync(c.spare, A);
  assert.equal(await provenPeer(c.p, { beforeRestat: () => { fs.renameSync(c.p, c.aside); fs.renameSync(c.spare, c.p); } }), null);
});

test("T15c a healthy unchanged peer records a tuple equal to a fresh stat, and the gate passes", async () => {
  const b = box(B);
  const tuple = await provenPeer(b.p);
  const s = fs.statSync(b.p, { bigint: true });
  assert.deepEqual(tuple, { dev: String(s.dev), ino: String(s.ino), size: String(s.size), mtimeNs: String(s.mtimeNs),
    sha256: crypto.createHash("sha256").update(B).digest("hex") });
  assert.equal(gate(b.p, tuple), "");
  assert.equal(await provenPeer(box(A).p), null, "a defective peer records nothing");
  assert.equal(await provenPeer(path.join(TMP, "missing.mts")), null, "a missing peer records nothing");
});

test("T15d every path closes the fd", { skip: process.platform === "win32" && "no /dev/fd on Windows" }, async () => {
  const open = (): number => fs.readdirSync("/dev/fd").length;
  const before = open();
  const b = box(B);
  await provenPeer(b.p, { beforeRead: () => { throw new Error("seam"); } });
  await provenPeer(b.p, { beforeVerdict: () => { throw new Error("seam"); } });
  await provenPeer(b.p, { beforeRestat: () => { fs.writeFileSync(b.p, "export const other = 2;\n"); } });
  await provenPeer(box(A).p);
  await provenPeer(b.dir);
  assert.equal(open(), before);
});

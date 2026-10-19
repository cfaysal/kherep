#!/usr/bin/env node
// Unit test for integrity-verdict.mts (issue #507, part 2): the three states of
// one hook file, a restore that counts only when measured at the target, and
// the journal append. Every case runs in its own mkdtemp tree; the libs the
// functions call are the real ones, passed in as the hook passes them.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { syntaxVerdict } from "./hook-syntax.mts";
import { classify, journal, type Repairer, restore } from "./integrity-verdict.mts";
import { writeExact } from "./restore-write.mts";
import { joinPathLike } from "./workspace-scope.mts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "integrity-verdict-")));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
const LIB = { syntaxVerdict, joinPathLike };
const GOOD = "export const ok = 1;\n";
const sha256 = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");
let seq = 0;

interface Box { home: string; hooks: string; repo: string }

function box(): Box {
  const root = path.join(TMP, `case-${++seq}`).replace(/\\/g, "/");
  const home = `${root}/home/.claude`;
  const repo = `${root}/repo`;
  fs.mkdirSync(`${home}/hooks`, { recursive: true });
  fs.mkdirSync(`${repo}/claude/hooks`, { recursive: true });
  return { home, hooks: `${home}/hooks`, repo };
}

test("classify: a healthy file is OK and keeps its stat", async () => {
  const { hooks } = box();
  fs.writeFileSync(`${hooks}/guard.mts`, GOOD);
  const verdict = await classify(LIB, `${hooks}/guard.mts`, "wired");
  assert.equal(verdict.state, "OK");
  assert.equal(verdict.before?.size, GOOD.length);
});

test("classify: 0 bytes, missing and a syntax error are DEFEKT", async () => {
  const { hooks } = box();
  fs.writeFileSync(`${hooks}/empty.mts`, "");
  fs.writeFileSync(`${hooks}/syntax.mts`, "export const x = ;\n");
  const empty = await classify(LIB, `${hooks}/empty.mts`, "wired");
  assert.equal(empty.state, "DEFEKT");
  assert.match(String(empty.reason), /0 bytes/);
  const missing = await classify(LIB, `${hooks}/missing.mts`, "imported");
  assert.deepEqual(missing, { state: "DEFEKT", reason: "imported but not present on disk" });
  const syntax = await classify(LIB, `${hooks}/syntax.mts`, "wired");
  assert.equal(syntax.state, "DEFEKT");
  assert.match(String(syntax.reason), /rejected by Node's parser/);
});

test("classify: a directory in the file's place is UNGEPRUEFT, not DEFEKT", async () => {
  const { hooks } = box();
  fs.mkdirSync(`${hooks}/dir.mts`);
  assert.deepEqual(await classify(LIB, `${hooks}/dir.mts`, "wired"), { state: "UNGEPRUEFT", reason: "not a regular file" });
});

// The runtime's capability, reduced to a direct write: the coordination itself is tested in hook-runtime-*.test.mts.
const direct = (hooks: string): Repairer => ({
  repair: async (rel, bytes) => {
    const why = writeExact(`${hooks}/${rel}`, bytes, hooks);
    return why ? { proven: false, why } : { proven: true, sha: sha256(Buffer.from(bytes).toString()) };
  },
});

test("restore: proven when the target holds the versioned bytes", async () => {
  const { hooks, repo } = box();
  fs.writeFileSync(`${repo}/claude/hooks/guard.mts`, GOOD);
  fs.writeFileSync(`${hooks}/guard.mts`, "");
  const result = await restore(LIB, direct(hooks), `${hooks}/guard.mts`, "guard.mts", repo);
  assert.deepEqual(result, { proven: true, sha: sha256(GOOD) });
  assert.equal(fs.readFileSync(`${hooks}/guard.mts`, "utf8"), GOOD);
});

test("restore: unproven without the runtime, without a checkout or with a 0-byte source", async () => {
  const { hooks, repo } = box();
  fs.writeFileSync(`${hooks}/guard.mts`, "");
  fs.writeFileSync(`${repo}/claude/hooks/guard.mts`, GOOD);
  assert.match(String((await restore(LIB, null, `${hooks}/guard.mts`, "guard.mts", repo)).why), /not coordinated/);
  assert.equal((await restore(LIB, direct(hooks), `${hooks}/guard.mts`, "guard.mts", "")).proven, false);
  fs.writeFileSync(`${repo}/claude/hooks/guard.mts`, "");
  const result = await restore(LIB, direct(hooks), `${hooks}/guard.mts`, "guard.mts", repo);
  assert.equal(result.proven, false);
  assert.match(String(result.why), /is itself 0 bytes/);
  assert.equal(fs.readFileSync(`${hooks}/guard.mts`, "utf8"), "");
});

test("restore: unproven when the target does not match after the write", async () => {
  const { hooks, repo } = box();
  fs.writeFileSync(`${repo}/claude/hooks/guard.mts`, GOOD);
  fs.writeFileSync(`${hooks}/guard.mts`, "");
  // A runtime that reports success and lands other bytes: the claim is no measurement.
  const lying: Repairer = { repair: async (rel) => { fs.writeFileSync(`${hooks}/${rel}`, "other bytes\n"); return { proven: true }; } };
  const result = await restore(LIB, lying, `${hooks}/guard.mts`, "guard.mts", repo);
  assert.equal(result.proven, false);
  assert.equal(result.sha, sha256("other bytes\n"));
  assert.match(String(result.why), /does not match the versioned source/);
});

test("journal: appends one JSON line per entry", () => {
  const { home } = box();
  journal(home, { file: "a.mts" });
  journal(home, { file: "b.mts" });
  const lines = fs.readFileSync(`${home}/.cache/hook-integrity/incidents.jsonl`, "utf8").trim().split("\n");
  assert.deepEqual(lines.map((line) => JSON.parse(line).file), ["a.mts", "b.mts"]);
});

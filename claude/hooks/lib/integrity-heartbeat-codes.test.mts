#!/usr/bin/env node
// Issue #576: the heartbeat and run.lock texts of integrity-heartbeat.mts print a
// code-less error by the #564 vocabulary (a Node error code, else the error's class
// name, else "unknown"), never its message. Every case runs in its own mkdtemp home.
// The vocabulary pin reads the eight files that hold a copy of that vocabulary.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { ABSOLUTE_PATH } from "./denial-journal.mts";
import { invalidateHeartbeat, takeRunLock, writeHeartbeat } from "./integrity-heartbeat.mts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "integrity-heartbeat-codes-")));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
let seq = 0;
const home = (): string => path.join(TMP, `case-${++seq}`, ".claude");
const REPO = path.resolve(import.meta.dirname, "..", "..", "..");
const clean = (text: string): void => {
  assert.doesNotMatch(text, ABSOLUTE_PATH, text);
  assert.ok(!/secret|boom|disk I\/O|bad handle/.test(text), text);
};

test("writeHeartbeat: a code, else the class name, else unknown", () => {
  const h = home();
  const failing = (thrown: unknown): string => writeHeartbeat(h, { trigger: "t", runtime: "claude", files: 1 }, { beforeRename: () => { throw thrown; } });
  const cases: [unknown, string][] = [
    [new Error("/Users/someone/secret dir/x failed"), "unknown"],
    ["C:\\Users\\x\\boom", "unknown"],
    [new TypeError("bad handle for ~/.claude/x"), "TypeError"],
    [Object.assign(new RangeError("/Users/x/secret"), { code: "bad-code" }), "RangeError"],
    [Object.assign(new Error("/Users/x/secret"), { code: "ENOSPC" }), "ENOSPC"],
    [{ name: "Custom", message: "/Users/x/secret" }, "unknown"],
    [null, "unknown"],
  ];
  for (const [thrown, code] of cases) {
    const text = failing(thrown);
    assert.equal(text, `heartbeat write failed: ${code}`, String(code));
    clean(text);
  }
});

test("takeRunLock: a code-less Error reads unknown, a TypeError its class name", () => {
  class Boom { constructor() { throw new Error("/private/var/folders/zz/run.lock.sqlite: disk I/O error"); } }
  class Bad {
    exec(sql: string): void { if (sql.startsWith("PRAGMA busy")) throw new TypeError("bad handle for ~/.codex/.cache/x"); }
    prepare() { return { get: () => ({ journal_mode: "delete" }) }; }
    close(): void {}
  }
  const seam = (DatabaseSync: unknown) => ({ sqlite: () => ({ DatabaseSync }) as unknown as typeof import("node:sqlite") });
  const boom = takeRunLock(home(), seam(Boom));
  const bad = takeRunLock(home(), seam(Bad));
  assert.equal(boom, "run.lock unavailable (unknown)");
  assert.equal(bad, "run.lock unavailable (TypeError)");
  for (const text of [boom, bad]) clean(String(text));
});

test("invalidateHeartbeat: a coded failure keeps its code", () => {
  const h = home();
  const beat = path.join(h, ".cache", "hook-integrity", "heartbeat.json");
  fs.mkdirSync(beat, { recursive: true });
  fs.writeFileSync(path.join(beat, "k"), "x");
  const text = invalidateHeartbeat(h);
  assert.match(text, /^heartbeat could not be removed: [A-Z][A-Z0-9_]{0,40}$/);
  clean(text);
});

// The same two validated regexes, each guarded by a string type test, in all eight copies.
test("the eight copies of the code vocabulary hold the same two validated regexes", () => {
  const files = ["claude/hooks/guard-dispatch.mts", "claude/hooks/live-hook-integrity.mts", "codex/hooks/hook-adapter-verdict.mts",
    "codex/hooks/shell-checks.mts", "codex/hooks/hook-integrity.mts", "claude/hooks/lib/integrity-heartbeat.mts",
    "claude/hooks/critical-file-integrity.mts", "claude/hooks/lib/hook-syntax.mts"];
  const code = /typeof (\w+) === "string" && \/\^\[A-Z\]\[A-Z0-9_\]\{0,40\}\$\/\.test\(\1\)/g;
  const name = /typeof (\w+) === "string" && \/\^\[A-Za-z\]\{1,40\}Error\$\/\.test\(\1\)/g;
  for (const rel of files) {
    const text = fs.readFileSync(path.join(REPO, rel), "utf8");
    assert.equal(text.match(code)?.length ?? 0, 1, `${rel}: the code regex`);
    assert.equal(text.match(name)?.length ?? 0, 1, `${rel}: the class-name regex`);
    assert.equal(text.split("/^[A-Z][A-Z0-9_]{0,40}$/").length - 1, 1, `${rel}: one code regex literal`);
    assert.equal(text.split("/^[A-Za-z]{1,40}Error$/").length - 1, 1, `${rel}: one class-name regex literal`);
  }
});

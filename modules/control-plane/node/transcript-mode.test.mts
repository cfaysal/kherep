import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TRANSCRIPT_TAIL_BYTES, transcriptMode } from "./transcript-mode.mts";

// Issue #101: the permission mode of a session whose SessionStart input
// carries none, from the last user entry of its transcript. Synthetic
// transcripts only, in a throwaway Claude config directory.

const user = (mode?: string, text = "synthetic prompt") =>
  JSON.stringify({ type: "user", message: { role: "user", content: text }, ...(mode ? { permissionMode: mode } : {}) });
const assistant = (text = "synthetic answer") => JSON.stringify({ type: "assistant", message: { role: "assistant", content: text } });

function home(t: test.TestContext) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-transcript-"));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  const project = path.join(configDir, "projects", "D--work-app");
  fs.mkdirSync(project, { recursive: true });
  const write = (lines: string[], name = "s-self.jsonl") => {
    const file = path.join(project, name);
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    return file;
  };
  return { configDir, project, write, read: (file: unknown) => transcriptMode(file, { configDir }) };
}

test("the mode of the last user entry that carries one", (t) => {
  const { write, read } = home(t);
  assert.equal(read(write([user("default"), assistant(), user("auto"), assistant()])), "auto");
  // A later user entry without the field, a summary line and a broken line are skipped.
  assert.equal(read(write([user("acceptEdits"), assistant(), user(), '{"type":"summary"}', "{not json", "[1,2]", ""])),
    "acceptEdits");
  // The field on a non-user entry does not count.
  assert.equal(read(write([user("default"), JSON.stringify({ type: "assistant", permissionMode: "plan" })])), "default");
  assert.equal(read(write([user("bypassPermissions"), assistant(), user("default")])), "default");
  assert.equal(read(write([user("default"), assistant(), user("bypassPermissions")])), "bypassPermissions");
});

test("no entry with the field, or an implausible value, is unknown", (t) => {
  const { write, read } = home(t);
  assert.equal(read(write([user(), assistant()])), undefined);
  assert.equal(read(write([])), undefined);
  assert.equal(read(write([JSON.stringify({ type: "user", permissionMode: 7 })])), undefined);
  assert.equal(read(write([user("x".repeat(64))])), undefined);
  assert.equal(read(write([user("de fault")])), undefined);
});

test("a missing, relative, foreign, directory or symlinked path is unknown", (t) => {
  const { configDir, project, write, read } = home(t);
  const file = write([user("default")]);
  assert.equal(read(file), "default");
  assert.equal(read(undefined), undefined);
  assert.equal(read(42), undefined);
  assert.equal(read(path.join(project, "missing.jsonl")), undefined);
  assert.equal(read(path.join("projects", "D--work-app", "s-self.jsonl")), undefined, "a relative path");
  assert.equal(read(project), undefined, "a directory");
  // Outside projects/: the config dir itself and a sibling directory.
  const outside = path.join(configDir, "s-self.jsonl");
  fs.writeFileSync(outside, `${user("default")}\n`);
  assert.equal(read(outside), undefined);
  const sibling = path.join(configDir, "projects-other", "s.jsonl");
  fs.mkdirSync(path.dirname(sibling), { recursive: true });
  fs.writeFileSync(sibling, `${user("default")}\n`);
  assert.equal(read(sibling), undefined);
  assert.equal(read(path.join(project, "..", "..", "s-self.jsonl")), undefined, "dot segments leave projects/");
  // A directory link (a junction on Windows) inside projects/ that leads outside it.
  fs.symlinkSync(path.dirname(sibling), path.join(configDir, "projects", "linked"), "junction");
  assert.equal(read(path.join(configDir, "projects", "linked", "s.jsonl")), undefined, "the real path leaves projects/");
  // A symlink inside projects/ to a file inside it, where the platform allows one.
  const link = path.join(project, "link.jsonl");
  try {
    fs.symlinkSync(file, link, "file");
  } catch {
    t.diagnostic("symlinks not permitted here");
    return;
  }
  assert.equal(read(link), undefined);
});

test("an unreadable transcript is unknown", { skip: process.platform === "win32" || process.getuid?.() === 0 }, (t) => {
  const { write, read } = home(t);
  const file = write([user("default")]);
  fs.chmodSync(file, 0o000);
  t.after(() => fs.chmodSync(file, 0o600));
  assert.equal(read(file), undefined);
});

test("only the tail of a large transcript is read", (t) => {
  const { write, read } = home(t);
  const filler = assistant("f".repeat(1024));
  const lines = Array.from({ length: Math.ceil((TRANSCRIPT_TAIL_BYTES * 2) / filler.length) }, () => filler);
  // The mode sits before the tail window only: unknown, never a guess.
  assert.equal(read(write([user("default"), ...lines])), undefined);
  // Within the window it is found; the older entry outside is not read.
  assert.equal(read(write([user("bypassPermissions"), ...lines, user("auto"), assistant()])), "auto");
  // A smaller window, injected, cuts through a line: that partial line is dropped.
  const { configDir } = home(t);
  const project = path.join(configDir, "projects", "p");
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, "s.jsonl");
  fs.writeFileSync(file, `${user("plan")}\n${assistant("x".repeat(200))}\n`);
  assert.equal(transcriptMode(file, { configDir, tailBytes: 150 }), undefined);
  assert.equal(transcriptMode(file, { configDir, tailBytes: 4096 }), "plan");
});

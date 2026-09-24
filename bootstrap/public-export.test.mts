import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EXCLUDE_FILE, exportRevision, isExcluded, parseExcludes } from "./public-export.mts";
import { readTar } from "./public-export-tar.mts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const identity = {
  GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.com",
};

function git(root: string, args: string[], input?: string): string {
  return execFileSync("git", ["-C", root, ...args], { input, env: { ...process.env, ...identity } })
    .toString().trim();
}

// Builds a commit with plumbing only, so no workspace hook takes part.
function fixture(t: test.TestContext, files: Record<string, string>, links: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "public-export-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "--quiet"]);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  git(root, ["add", "--all"]);
  for (const [name, target] of Object.entries(links)) {
    const blob = git(root, ["hash-object", "-w", "--stdin"], target);
    git(root, ["update-index", "--add", "--cacheinfo", `120000,${blob},${name}`]);
  }
  git(root, ["update-ref", "HEAD", git(root, ["commit-tree", git(root, ["write-tree"]), "-m", "fixture"])]);
  return root;
}

const excludes = "# comment\ndocs/handover/\nanalysis/\n_deprecated/\nmodules/app/ops/private/\n";
const baseFiles = {
  [EXCLUDE_FILE]: excludes,
  "README.md": "public\n",
  "docs/guide.md": "guide\n",
  "docs/handover/notes.md": "internal\n",
  "analysis/plan.md": "internal\n",
  "_deprecated/old.md": "retired\n",
  "codex/_deprecated/older.md": "retired\n",
  "codex/keep_deprecated.md": "kept\n",
  "modules/app/ops/private/job.yaml": "internal\n",
  "modules/app/ops/public/job.yaml": "public\n",
  "windows.cmd": "line\n",
  ".gitattributes": "*.cmd text eol=crlf\n",
};

test("exclude entries are root-anchored with a slash and match any depth as a single name", () => {
  const patterns = parseExcludes(excludes);
  assert.deepEqual(patterns, ["docs/handover/", "analysis/", "_deprecated/", "modules/app/ops/private/"]);
  assert.equal(isExcluded("docs/handover/a.md", patterns), true);
  assert.equal(isExcluded("x/docs/handover/a.md", patterns), false);
  assert.equal(isExcluded("codex/_deprecated/a.md", patterns), true);
  assert.equal(isExcluded("codex/keep_deprecated.md", patterns), false);
  assert.equal(isExcluded("analysis.md", patterns), false);
  for (const bad of ["docs/handover", "/analysis/", "../x/", "a//b/", ""]) {
    assert.throws(() => parseExcludes(bad));
  }
});

test("exports the revision without excluded paths, .git or symlinks and writes a hash manifest", (t) => {
  const root = fixture(t, baseFiles, { "_deprecated/link": "README.md" });
  const out = path.join(root, "..", `${path.basename(root)}-out`);
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  t.after(() => fs.rmSync(`${out}.sha256`, { force: true }));
  const result = exportRevision(root, "HEAD", out);
  assert.equal(result.revision, git(root, ["rev-parse", "HEAD"]));
  const expected = [".gitattributes", EXCLUDE_FILE, "README.md", "codex/keep_deprecated.md",
    "docs/guide.md", "modules/app/ops/public/job.yaml", "windows.cmd"].sort();
  const lines = fs.readFileSync(result.manifest, "utf8").trim().split("\n");
  assert.deepEqual(lines.map((line) => line.slice(66)), expected);
  assert.equal(result.files, expected.length);
  for (const line of lines) {
    const bytes = fs.readFileSync(path.join(out, line.slice(66)));
    assert.equal(line.slice(0, 64), crypto.createHash("sha256").update(bytes).digest("hex"));
  }
  for (const gone of [".git", "docs/handover", "analysis", "_deprecated", "codex/_deprecated", "modules/app/ops/private"]) {
    assert.equal(fs.existsSync(path.join(out, gone)), false, gone);
  }
  assert.equal(fs.readFileSync(path.join(out, "windows.cmd"), "utf8"), "line\r\n");
});

test("fails when a symlink would enter the export", (t) => {
  const root = fixture(t, baseFiles, { "docs/link": "README.md" });
  const out = path.join(root, "..", `${path.basename(root)}-out`);
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  assert.throws(() => exportRevision(root, "HEAD", out), /Non-regular entry in the export: docs\/link/);
});

test("refuses a non-empty output directory and a revision without an exclude list", (t) => {
  const root = fixture(t, baseFiles);
  const busy = fs.mkdtempSync(path.join(os.tmpdir(), "public-export-busy-"));
  t.after(() => fs.rmSync(busy, { recursive: true, force: true }));
  fs.writeFileSync(path.join(busy, "keep.txt"), "x");
  assert.throws(() => exportRevision(root, "HEAD", busy), /not empty/);
  const bare = fixture(t, { "README.md": "x\n" });
  assert.throws(() => exportRevision(bare, "HEAD", path.join(busy, "sub")));
});

function tarHeader(name: string, content = ""): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000644\0", 100);
  header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("0", 156);
  header.write("ustar\0", 257);
  const body = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  body.write(content);
  return Buffer.concat([header, body]);
}

test("the tar reader returns regular entries and rejects names that escape on any platform", () => {
  const end = Buffer.alloc(1024);
  const entries = readTar(Buffer.concat([tarHeader("docs/a.md", "hello\n"), end]));
  assert.deepEqual(entries.map((entry) => [entry.path, entry.type, entry.data.toString()]),
    [["docs/a.md", "file", "hello\n"]]);
  for (const name of ["..\\evil", "a\\..\\..\\x", "C:/x", "a:stream", "/abs", "a/../../x"]) {
    assert.throws(() => readTar(Buffer.concat([tarHeader(name), end])), /Unsafe path/, name);
  }
});

test("a regular file named like a single-name entry is exported", (t) => {
  const root = fixture(t, { ...baseFiles, "notes/_deprecated": "a file, not a directory\n" });
  const out = path.join(root, "..", `${path.basename(root)}-out`);
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  t.after(() => fs.rmSync(`${out}.sha256`, { force: true }));
  exportRevision(root, "HEAD", out);
  assert.equal(fs.existsSync(path.join(out, "notes", "_deprecated")), true);
});

test("the repository exclude list keeps the private paths out of every export", () => {
  const patterns = parseExcludes(fs.readFileSync(path.join(repoRoot, EXCLUDE_FILE), "utf8"));
  for (const required of ["docs/handover/", "analysis/", "docs/superpowers/", "_deprecated/"]) {
    assert.ok(patterns.includes(required), required);
  }
});

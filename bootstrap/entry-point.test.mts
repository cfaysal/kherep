// Every Kherep entry point and hook decides whether it was started directly by
// comparing import.meta.url with the real path of process.argv[1]. Two older
// forms fail silently, and a hook that silently does nothing is a disabled
// guard:
//
// - The main flag on import.meta is undefined on Node 23 and 24.0-24.1, which
//   the engines range admits, so the script exits 0 without running.
// - Node loads the main module from its real path, so pathToFileURL of the
//   unresolved argv[1] never matches when the script path contains a symlink
//   (macOS /var -> /private/var).
//
// The scan reads the tracked files from the working tree. Without a Git
// checkout of this repository, such as the archive copy the smoke test builds,
// it skips with the reason.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const repo = path.resolve(import.meta.dirname, "..");
const SOURCE = /\.(?:mts|ts|mjs|js)$/;
const MAIN_FLAG = /import\.meta\.main\b/;
const UNRESOLVED_ARGV = /pathToFileURL\(\s*process\.argv\[1\]/;

function git(args: string[]) {
  return spawnSync("git", args, { cwd: repo, encoding: "utf8" });
}

// A list of tracked source files, or the reason there is none to scan.
function trackedSources(): string[] | string {
  const prefix = git(["rev-parse", "--show-prefix"]);
  if (prefix.error) return `git is unavailable: ${prefix.error.message}`;
  if (prefix.status !== 0 || prefix.stdout.trim() !== "") return "not a Git checkout of this repository";
  const listed = git(["ls-files", "-z"]);
  if (listed.error || listed.status !== 0) return `git ls-files failed: ${listed.stderr.trim()}`;
  return listed.stdout.split("\0").filter((file) => SOURCE.test(file) && fs.existsSync(path.join(repo, file)));
}

function offending(files: string[], pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const file of files) {
    fs.readFileSync(path.join(repo, file), "utf8").split(/\r?\n/).forEach((line, index) => {
      if (pattern.test(line)) hits.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  return hits;
}

const sources = trackedSources();

test("no tracked source file relies on the main flag of import.meta", (t) => {
  if (typeof sources === "string") {
    t.skip(sources);
    return;
  }
  assert.ok(sources.length > 0, "git ls-files listed no source files");
  assert.deepEqual(offending(sources, MAIN_FLAG), [],
    "use the isMainModule() real-path check instead; Node 23 and 24.0-24.1 lack the flag");
});

test("no tracked source file compares import.meta.url with an unresolved argv[1]", (t) => {
  if (typeof sources === "string") {
    t.skip(sources);
    return;
  }
  assert.ok(sources.length > 0, "git ls-files listed no source files");
  assert.deepEqual(offending(sources, UNRESOLVED_ARGV), [],
    "resolve argv[1] with fs.realpathSync first, as isMainModule() does");
});

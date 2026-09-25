// Every Kherep entry point and hook decides whether it was started directly
// with isMainModule(): import.meta.url against process.argv[1], both as given
// and resolved to its real path. The older forms fail silently, and a hook that
// silently does nothing is a disabled guard:
//
// - The main flag on import.meta is undefined on Node 23 and 24.0-24.1, so the
//   script exits 0 without running.
// - Node loads the main module from its real path, so the argument as given
//   never matches when the script path contains a symlink (macOS /var ->
//   /private/var).
// - Under --preserve-symlinks-main Node keeps the path as given, so the real
//   path alone never matches either.
//
// The scan reads the tracked files from the working tree. Without a Git
// checkout of this repository, such as the archive copy the smoke test builds,
// it skips with the reason. codex/parity/plugin-sources is a vendored snapshot
// of third-party plugins that has to stay byte-identical, so it is not scanned.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const repo = path.resolve(import.meta.dirname, "..");
const SOURCE = /\.(?:mts|ts|mjs|js)$/;
const VENDORED = "codex/parity/plugin-sources/";

// The main flag read as a property, optionally chained, by index, or taken
// apart in a destructuring from import.meta.
const MAIN_FLAG = [
  /import\s*\.\s*meta\s*(?:\?\.|\.)\s*main\b/,
  /import\s*\.\s*meta\s*(?:\?\.)?\s*\[\s*["'`]main["'`]\s*\]/,
  /\{[^}]*\bmain\b[^}]*\}\s*=\s*import\s*\.\s*meta\b/,
];

// argv[1] compared or turned into a URL as given, which only one of the two
// path forms can match. isMainModule() reads it once into a local instead.
const UNRESOLVED_ARGV = [
  /pathToFileURL\(\s*(?:path\.)?(?:resolve\(\s*)?process\.argv\[1\]/,
  /[!=]==?\s*process\.argv\[1\]/,
  /process\.argv\[1\]\s*[!=]==?/,
];

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
  return listed.stdout.split("\0").filter((file) => SOURCE.test(file) && !file.startsWith(VENDORED)
    && fs.existsSync(path.join(repo, file)));
}

const read = (file: string): string => fs.readFileSync(path.join(repo, file), "utf8");

function offending(files: string[], patterns: RegExp[]): string[] {
  const hits: string[] = [];
  for (const file of files) {
    read(file).split(/\r?\n/).forEach((line, index) => {
      if (patterns.some((pattern) => pattern.test(line))) hits.push(`${file}:${index + 1}: ${line.trim()}`);
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
    "use the isMainModule() check instead; Node 23 and 24.0-24.1 lack the flag");
});

test("no tracked source file compares import.meta.url with argv[1] in only one form", (t) => {
  if (typeof sources === "string") {
    t.skip(sources);
    return;
  }
  assert.ok(sources.length > 0, "git ls-files listed no source files");
  assert.deepEqual(offending(sources, UNRESOLVED_ARGV), [],
    "compare with argv[1] as given and resolved with realpathSync, as isMainModule() does");
});

test("every isMainModule() accepts argv[1] both as given and as its real path", (t) => {
  if (typeof sources === "string") {
    t.skip(sources);
    return;
  }
  const guards = sources.filter((file) => /^function isMainModule\(/m.test(read(file)));
  assert.ok(guards.length > 0, "no tracked file defines isMainModule()");
  const incomplete = guards.filter((file) => {
    const source = read(file);
    return !source.includes("realpathSync(") || !source.includes("path.resolve(");
  });
  assert.deepEqual(incomplete, [], "isMainModule() without realpathSync( or path.resolve(");
});
